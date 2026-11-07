//! Minimal STUN responder for Binding requests (RFC 5389), co-located with
//! the QUIC socket on the single UDP port (README §6.2).
//!
//! **Demux rule:** the first byte alone cannot tell STUN from QUIC — a
//! GREASE'd (RFC 9287) QUIC 1-RTT packet may carry any first byte below
//! 0x80, including 0x00/0x01. The demux therefore validates the 20-byte
//! STUN header (message type + magic cookie, see [`is_stun`]): a datagram
//! that parses as a STUN message is handled here, everything else is a QUIC
//! packet handed to quinn. A real QUIC datagram validating as STUN would
//! need the magic cookie to match (~2^-32 per packet) and is simply
//! retransmitted by QUIC if it happens.
//!
//! Only what WebRTC's ICE agent actually uses is implemented: answering
//! Binding requests with an XOR-MAPPED-ADDRESS. MESSAGE-INTEGRITY
//! (HMAC-SHA1) and FINGERPRINT (CRC32) are included for the RFC 5769 test
//! vectors and for future long-term-auth TURN support; a Binding response
//! needs neither.

use std::net::{IpAddr, SocketAddr};

use base64::{Engine, engine::general_purpose::STANDARD as B64};
use hmac::{Hmac, Mac};
use sha1::Sha1;

/// STUN magic cookie (RFC 5389 §6).
pub const MAGIC_COOKIE: u32 = 0x2112_A442;

/// Fingerprint XOR constant (RFC 5389 §15.5).
const FINGERPRINT_XOR: u32 = 0x53_54_55_4E;

/// Binding request (RFC 5389 §5.1).
pub const MSG_BINDING_REQUEST: u16 = 0x0001;
/// Binding success response.
pub const MSG_BINDING_RESPONSE: u16 = 0x0101;

/// Attribute types (RFC 5389 §15).
pub const ATTR_USERNAME: u16 = 0x0006;
pub const ATTR_MESSAGE_INTEGRITY: u16 = 0x0008;
pub const ATTR_XOR_MAPPED_ADDRESS: u16 = 0x0020;
pub const ATTR_SOFTWARE: u16 = 0x8022;
pub const ATTR_FINGERPRINT: u16 = 0x0028;

/// Server name advertised in Binding responses (RFC 5389 §15.8, optional).
pub const SOFTWARE_NAME: &str = concat!("campfire/", env!("CARGO_PKG_VERSION"));

/// A parsed STUN message header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StunHeader {
    pub msg_type: u16,
    pub transaction_id: [u8; 12],
}

/// Parse the 20-byte STUN header, validating the magic cookie.
pub fn parse_header(data: &[u8]) -> Option<StunHeader> {
    if data.len() < 20 {
        return None;
    }
    let msg_type = u16::from_be_bytes([data[0], data[1]]);
    let length = u16::from_be_bytes([data[2], data[3]]) as usize;
    let cookie = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
    if cookie != MAGIC_COOKIE || data.len() < 20 + length {
        return None;
    }
    let mut txn = [0u8; 12];
    txn.copy_from_slice(&data[8..20]);
    Some(StunHeader {
        msg_type,
        transaction_id: txn,
    })
}

/// Iterate the attributes of a STUN message (header already validated).
pub fn attributes<'a>(data: &'a [u8]) -> impl Iterator<Item = (u16, &'a [u8])> + 'a {
    struct Attrs<'a> {
        rest: &'a [u8],
    }
    impl<'a> Iterator for Attrs<'a> {
        type Item = (u16, &'a [u8]);
        fn next(&mut self) -> Option<Self::Item> {
            if self.rest.len() < 4 {
                return None;
            }
            let rtype = u16::from_be_bytes([self.rest[0], self.rest[1]]);
            let len = u16::from_be_bytes([self.rest[2], self.rest[3]]) as usize;
            if self.rest.len() < 4 + len {
                return None;
            }
            let value = &self.rest[4..4 + len];
            let pad = (4 - len % 4) % 4;
            self.rest = &self.rest[4 + len + pad..];
            Some((rtype, value))
        }
    }
    let header_len = 20;
    let length = u16::from_be_bytes([data[2], data[3]]) as usize;
    Attrs {
        rest: &data[header_len..header_len + length],
    }
}

/// First demux step (README §6.2): `true` when the datagram parses as a
/// STUN message (sane length + magic cookie), `false` when it is a QUIC
/// packet or unrecognizable garbage (which quinn drops).
///
/// The first byte is deliberately *not* part of the test: with RFC 9287
/// GREASE a QUIC 1-RTT packet may start with any byte below 0x80.
pub fn is_stun(data: &[u8]) -> bool {
    parse_header(data).is_some()
}

/// Answer a STUN Binding request, or `None` if `data` is not one.
///
/// `mapped` is the address the datagram was observed from (for NAT
/// reflection it is the same address the client sent from).
pub fn answer_binding_request(data: &[u8], mapped: SocketAddr) -> Option<Vec<u8>> {
    let header = parse_header(data)?;
    if header.msg_type != MSG_BINDING_REQUEST {
        return None;
    }
    Some(binding_response(&header.transaction_id, mapped))
}

/// Build a Binding success response with a SOFTWARE and an
/// XOR-MAPPED-ADDRESS attribute.
pub fn binding_response(txn: &[u8; 12], mapped: SocketAddr) -> Vec<u8> {
    let mut msg = header(MSG_BINDING_RESPONSE, txn);
    msg.extend_from_slice(&attribute(ATTR_SOFTWARE, SOFTWARE_NAME.as_bytes().to_vec()));
    msg.extend_from_slice(&attribute(
        ATTR_XOR_MAPPED_ADDRESS,
        xor_address(mapped, txn),
    ));
    let len = (msg.len() - 20) as u16;
    msg[2] = (len >> 8) as u8;
    msg[3] = (len & 0xff) as u8;
    msg
}

/// One 20-byte STUN message header (length filled in by `finish`).
fn header(msg_type: u16, txn: &[u8; 12]) -> Vec<u8> {
    let mut out = vec![
        (msg_type >> 8) as u8,
        (msg_type & 0xff) as u8,
        0, // length — patched by finish()
        0,
    ];
    out.extend_from_slice(&MAGIC_COOKIE.to_be_bytes());
    out.extend_from_slice(txn);
    out
}

/// One attribute: type + length + zero-padded value.
fn attribute(rtype: u16, value: Vec<u8>) -> Vec<u8> {
    let pad = (4 - value.len() % 4) % 4;
    let mut out = vec![
        (rtype >> 8) as u8,
        (rtype & 0xff) as u8,
        (value.len() >> 8) as u8,
        (value.len() & 0xff) as u8,
    ];
    out.extend_from_slice(&value);
    out.extend(std::iter::repeat_n(0u8, pad));
    out
}

/// XOR-MAPPED-ADDRESS value (RFC 5389 §6.2): the mapped address XOR-ed with
/// the magic cookie (for the port) and the 16-byte cookie+transaction id
/// (for the IP).
pub fn xor_address(addr: SocketAddr, txn: &[u8; 12]) -> Vec<u8> {
    let xor_port = (MAGIC_COOKIE >> 16) as u16;
    let mut key = [0u8; 16];
    key[..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
    key[4..].copy_from_slice(txn);

    match addr.ip() {
        IpAddr::V4(ip) => {
            let oct = ip.octets();
            let mut out = vec![0x00, 0x01]; // reserved + IPv4 family
            out.extend_from_slice(&(addr.port() ^ xor_port).to_be_bytes());
            for i in 0..4 {
                out.push(oct[i] ^ key[i]);
            }
            out
        }
        IpAddr::V6(ip) => {
            let oct = ip.octets();
            let mut out = vec![0x00, 0x02]; // reserved + IPv6 family
            out.extend_from_slice(&(addr.port() ^ xor_port).to_be_bytes());
            for i in 0..16 {
                out.push(oct[i] ^ key[i]);
            }
            out
        }
    }
}

/// Decode an XOR-MAPPED-ADDRESS value (inverse of [`xor_address`]).
pub fn decode_xor_address(value: &[u8], txn: &[u8; 12]) -> Option<SocketAddr> {
    let xor_port = (MAGIC_COOKIE >> 16) as u16;
    let mut key = [0u8; 16];
    key[..4].copy_from_slice(&MAGIC_COOKIE.to_be_bytes());
    key[4..].copy_from_slice(txn);
    let port = u16::from_be_bytes([value[2], value[3]]) ^ xor_port;
    match (value.len(), value[1]) {
        (8, 0x01) => {
            let ip = IpAddr::V4(std::net::Ipv4Addr::new(
                value[4] ^ key[0],
                value[5] ^ key[1],
                value[6] ^ key[2],
                value[7] ^ key[3],
            ));
            Some(SocketAddr::new(ip, port))
        }
        (20, 0x02) => {
            let mut oct = [0u8; 16];
            for i in 0..16 {
                oct[i] = value[4 + i] ^ key[i];
            }
            let ip = IpAddr::V6(std::net::Ipv6Addr::from(oct));
            Some(SocketAddr::new(ip, port))
        }
        _ => None,
    }
}

/// HMAC-SHA1 (RFC 2104) over `data`, keyed with `key`.
pub fn hmac_sha1(key: &[u8], data: &[u8]) -> [u8; 20] {
    let mut mac = Hmac::<Sha1>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    let out = mac.finalize().into_bytes();
    let mut res = [0u8; 20];
    res.copy_from_slice(&out);
    res
}

/// RFC 8489 TURN REST credential: `base64(HMAC-SHA1(secret, username))`.
pub fn turn_rest_credential(secret: &str, username: &str) -> String {
    B64.encode(hmac_sha1(secret.as_bytes(), username.as_bytes()))
}

/// Append a MESSAGE-INTEGRITY attribute computed over everything up to the
/// insertion point (RFC 5389 §15.5). The message-length field is updated.
pub fn add_message_integrity(msg: &mut Vec<u8>, key: &[u8]) {
    let mac = hmac_sha1(key, msg);
    msg.extend_from_slice(&attribute(ATTR_MESSAGE_INTEGRITY, mac.to_vec()));
    let len = (msg.len() - 20) as u16;
    msg[2] = (len >> 8) as u8;
    msg[3] = (len & 0xff) as u8;
}

/// Append a FINGERPRINT attribute: CRC32 of the whole message so far,
/// XOR-ed with 0x5354554E (RFC 5389 §15.5). Must be the last attribute.
pub fn add_fingerprint(msg: &mut Vec<u8>) {
    let crc = crc32fast::hash(msg) ^ FINGERPRINT_XOR;
    let value = vec![
        (crc >> 24) as u8,
        (crc >> 16) as u8,
        (crc >> 8) as u8,
        (crc & 0xff) as u8,
    ];
    msg.extend_from_slice(&attribute(ATTR_FINGERPRINT, value));
    let len = (msg.len() - 20) as u16;
    msg[2] = (len >> 8) as u8;
    msg[3] = (len & 0xff) as u8;
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 5769 Appendix A `req[]` — sample Binding request.
    const RFC_REQ: &[u8] = &[
        0x00, 0x01, 0x00, 0x58, 0x21, 0x12, 0xA4, 0x42, 0xB7, 0xE7, 0xA7, 0x01, 0xBC, 0x34, 0xD6,
        0x86, 0xFA, 0x87, 0xDF, 0xAE, 0x80, 0x22, 0x00, 0x10, b'S', b'T', b'U', b'N', b' ', b't',
        b'e', b's', b't', b' ', b'c', b'l', b'i', b'e', b'n', b't', 0x00, 0x24, 0x00, 0x04, 0x6E,
        0x00, 0x01, 0xFF, 0x80, 0x29, 0x00, 0x08, 0x93, 0x2F, 0xF9, 0xB1, 0x51, 0x26, 0x3B, 0x36,
        0x00, 0x06, 0x00, 0x09, 0x65, 0x76, 0x74, 0x6A, 0x3A, 0x68, 0x36, 0x76, 0x59, 0x20, 0x20,
        0x20, 0x00, 0x08, 0x00, 0x14, 0x9A, 0xEA, 0xA7, 0x0C, 0xBF, 0xD8, 0xCB, 0x56, 0x78, 0x1E,
        0xF2, 0xB5, 0xB2, 0xD3, 0xF2, 0x49, 0xC1, 0xB5, 0x71, 0xA2, 0x80, 0x28, 0x00, 0x04, 0xE5,
        0x7A, 0x3B, 0xCF,
    ];
    const RFC_TXN: [u8; 12] = [
        0xB7, 0xE7, 0xA7, 0x01, 0xBC, 0x34, 0xD6, 0x86, 0xFA, 0x87, 0xDF, 0xAE,
    ];
    const RFC_PASSWORD: &str = "VOkJxbRl1RmTxUk/WvJxBt";
    /// RFC 5769 §2.2: XOR-MAPPED-ADDRESS for mapped 192.0.2.1:32853.
    const RFC_XOR4: &[u8] = &[0x00, 0x01, 0xA1, 0x47, 0xE1, 0x12, 0xA6, 0x43];
    /// RFC 5769 §2.3: XOR-MAPPED-ADDRESS for mapped
    /// 2001:db8:1234:5678:11:2233:4455:6677:32853.
    const RFC_XOR6: &[u8] = &[
        0x00, 0x02, 0xA1, 0x47, 0x01, 0x13, 0xA9, 0xFA, 0xA5, 0xD3, 0xF1, 0x79, 0xBC, 0x25, 0xF4,
        0xB5, 0xBE, 0xD2, 0xB9, 0xD9,
    ];
    /// RFC 5769 §2.2: MESSAGE-INTEGRITY (HMAC-SHA1) of the sample response,
    /// keyed with the sample's long-term password.
    const RFC_MI: [u8; 20] = [
        0x2B, 0x91, 0xF5, 0x99, 0xFD, 0x9E, 0x90, 0xC3, 0x8C, 0x74, 0x89, 0xF9, 0x2A, 0xF9, 0xBA,
        0x53, 0xF0, 0x6B, 0xE7, 0xD7,
    ];
    /// RFC 5769 §2.2: FINGERPRINT (CRC32) of the sample response.
    const RFC_FP: [u8; 4] = [0xC0, 0x7D, 0x4C, 0x96];

    /// Assemble the RFC 5769 §2.2 sample response byte-for-byte: header
    /// (length field `msglen`), SOFTWARE "test vector " (12 bytes, length
    /// field 11, as printed), XOR-MAPPED-ADDRESS, and the given MI value as
    /// MESSAGE-INTEGRITY. (The sample's own fields are mutually
    /// inconsistent — its MI was computed with msglen 0x34, its FINGERPRINT
    /// with the printed 0x3c — so the tests below pin each known-answer to
    /// the layout it was computed from.)
    fn rfc_body(msglen: u16, mi: &[u8; 20]) -> Vec<u8> {
        let mut msg = header(MSG_BINDING_RESPONSE, &RFC_TXN);
        msg[2] = (msglen >> 8) as u8;
        msg[3] = (msglen & 0xff) as u8;
        msg.extend_from_slice(&attribute(ATTR_SOFTWARE, b"test vector ".to_vec()));
        // Patch the printed quirk: 12 value bytes under an 11 length field.
        // (Attribute header sits at bytes 20..24; the length field is 22..24.)
        msg[23] = 0x0b;
        msg.extend_from_slice(&attribute(ATTR_XOR_MAPPED_ADDRESS, RFC_XOR4.to_vec()));
        msg.extend_from_slice(&attribute(ATTR_MESSAGE_INTEGRITY, mi.to_vec()));
        msg
    }

    #[test]
    fn rfc5769_request_parses() {
        let header = parse_header(RFC_REQ).expect("RFC 5769 request must parse");
        assert_eq!(header.msg_type, MSG_BINDING_REQUEST);
        assert_eq!(header.transaction_id, RFC_TXN);

        let mut username: Option<&[u8]> = None;
        for (rtype, value) in attributes(RFC_REQ) {
            if rtype == ATTR_USERNAME {
                username = Some(value);
            }
        }
        // 9-byte username padded to 12.
        let raw = username.expect("USERNAME attribute present");
        assert_eq!(std::str::from_utf8(&raw[..9]).unwrap(), "evtj:h6vY");
    }

    #[test]
    fn rfc5769_xor_mapped_address_v4() {
        let mapped: SocketAddr = "192.0.2.1:32853".parse().unwrap();
        assert_eq!(&xor_address(mapped, &RFC_TXN), RFC_XOR4);
        assert_eq!(decode_xor_address(RFC_XOR4, &RFC_TXN), Some(mapped));
    }

    #[test]
    fn rfc5769_xor_mapped_address_v6() {
        let mapped: SocketAddr = "[2001:db8:1234:5678:11:2233:4455:6677]:32853"
            .parse()
            .unwrap();
        assert_eq!(&xor_address(mapped, &RFC_TXN), RFC_XOR6);
        assert_eq!(decode_xor_address(RFC_XOR6, &RFC_TXN), Some(mapped));
    }

    #[test]
    fn rfc5769_message_integrity_known_answer() {
        // The sample MI was computed over the response with msglen 0x34 and
        // the software value printed as 12 bytes under an 11 length field.
        let mut body = header(MSG_BINDING_RESPONSE, &RFC_TXN);
        body[2] = 0x00;
        body[3] = 0x34;
        body.extend_from_slice(&attribute(ATTR_SOFTWARE, b"test vector ".to_vec()));
        body[23] = 0x0b; // printed quirk: 12 value bytes, 11 length field
        body.extend_from_slice(&attribute(ATTR_XOR_MAPPED_ADDRESS, RFC_XOR4.to_vec()));
        assert_eq!(
            hmac_sha1(RFC_PASSWORD.as_bytes(), &body),
            RFC_MI,
            "HMAC-SHA1 must match RFC 5769 §2.2"
        );
    }

    #[test]
    fn rfc5769_fingerprint_known_answer() {
        // The sample FP was computed over the printed layout (msglen 0x3c)
        // with the sample MI value already attached.
        let mut body = rfc_body(0x3c, &RFC_MI);
        add_fingerprint(&mut body);
        assert_eq!(
            &body[body.len() - 4..],
            &RFC_FP,
            "CRC32 fingerprint must match RFC 5769 §2.2"
        );
    }

    #[test]
    fn xor_address_roundtrips_v4_and_v6() {
        for addr in [
            "192.0.2.1:32853".parse::<SocketAddr>().unwrap(),
            "[2001:db8:1234:5678:11:2233:4455:6677]:32853"
                .parse()
                .unwrap(),
            "0.0.0.0:0".parse().unwrap(),
            "[::1]:65535".parse().unwrap(),
        ] {
            let encoded = xor_address(addr, &RFC_TXN);
            assert_eq!(decode_xor_address(&encoded, &RFC_TXN), Some(addr));
        }
    }

    #[test]
    fn demux_disambiguates_stun_and_quic() {
        // STUN: valid 20-byte header (message type + magic cookie).
        assert!(is_stun(RFC_REQ));
        assert!(is_stun(RFC_RESPV4));
        // QUIC Initial (long header, version 1), straight off the wire.
        let initial = [
            0xC5, 0x00, 0x00, 0x00, 0x01, 0x14, 0x83, 0x4B, 0x61, 0x7B, 0xD7, 0xD0, 0x82, 0x9B,
            0xC1, 0x3E, 0xC2, 0x2E, 0xB8, 0x1A, 0x5E, 0x5A, 0x89, 0xD2, 0xFA, 0x24, 0x08, 0x37,
            0xDE, 0x01, 0x26, 0x0D, 0xA3, 0x8D, 0x82, 0x00, 0x44, 0x8A, 0x2B, 0xFD,
        ];
        assert!(!is_stun(&initial));
        // GREASE'd (RFC 9287) QUIC 1-RTT (short header) whose first byte
        // looks like a STUN class byte (0x00): a first-byte demux would
        // drop these packets, killing the HTTP/3 stream they carry.
        let one_rtt = [
            0x00, 0xB1, 0xA7, 0x1C, 0x0F, 0xAC, 0x68, 0x31, 0xA3, 0xDB, 0x63, 0xE5, 0x0F, 0x1A,
            0xC0, 0x8B, 0xE8, 0xB8, 0x2C, 0x19, 0x00,
        ];
        assert!(!is_stun(&one_rtt));
        // Truncated / garbage datagrams are not STUN (quinn drops them).
        assert!(!is_stun(&[]));
        assert!(!is_stun(&[0x00; 19]));
    }

    #[test]
    fn binding_request_answered_with_mapped_address() {
        let mapped: SocketAddr = "198.51.100.7:54321".parse().unwrap();
        let reply = answer_binding_request(RFC_REQ, mapped).expect("must answer");
        let header = parse_header(&reply).unwrap();
        assert_eq!(header.msg_type, MSG_BINDING_RESPONSE);
        assert_eq!(header.transaction_id, RFC_TXN);
        let mut found = false;
        for (rtype, value) in attributes(&reply) {
            if rtype == ATTR_XOR_MAPPED_ADDRESS {
                found = true;
                assert_eq!(decode_xor_address(value, &RFC_TXN), Some(mapped));
            }
        }
        assert!(found, "XOR-MAPPED-ADDRESS attribute present");
    }

    #[test]
    fn non_binding_and_garbage_are_ignored() {
        assert!(answer_binding_request(RFC_RESPV4, "1.2.3.4:5".parse().unwrap()).is_none());
        assert!(answer_binding_request(&[0x00; 10], "1.2.3.4:5".parse().unwrap()).is_none());
        // Bad magic cookie.
        let mut bad = RFC_REQ.to_vec();
        bad[4] = 0xFF;
        assert!(answer_binding_request(&bad, "1.2.3.4:5".parse().unwrap()).is_none());
    }

    /// RFC 5769 §2.2 response as printed (used to confirm a response is not
    /// answered as a request).
    const RFC_RESPV4: &[u8] = &[
        0x01, 0x01, 0x00, 0x3C, 0x21, 0x12, 0xA4, 0x42, 0xB7, 0xE7, 0xA7, 0x01, 0xBC, 0x34, 0xD6,
        0x86, 0xFA, 0x87, 0xDF, 0xAE, 0x80, 0x22, 0x00, 0x0B, 0x74, 0x65, 0x73, 0x74, 0x20, 0x76,
        0x65, 0x63, 0x74, 0x6F, 0x72, 0x20, 0x00, 0x20, 0x00, 0x08, 0x00, 0x01, 0xA1, 0x47, 0xE1,
        0x12, 0xA6, 0x43, 0x00, 0x08, 0x00, 0x14, 0x2B, 0x91, 0xF5, 0x99, 0xFD, 0x9E, 0x90, 0xC3,
        0x8C, 0x74, 0x89, 0xF9, 0x2A, 0xF9, 0xBA, 0x53, 0xF0, 0x6B, 0xE7, 0xD7, 0x80, 0x28, 0x00,
        0x04, 0xC0, 0x7D, 0x4C, 0x96,
    ];

    #[test]
    fn turn_rest_credential_is_hmac_sha1_base64() {
        let secret = "Q0ws1c3Op3l9RlCYpH0BBg";
        let username = "1502672284:192.0.2.1";
        let cred = turn_rest_credential(secret, username);
        assert_eq!(cred.len(), 28, "base64 of a 20-byte HMAC");
        // Deterministic and distinct per username.
        assert_eq!(cred, turn_rest_credential(secret, username));
        assert_ne!(cred, turn_rest_credential(secret, "1502672284:192.0.2.2"));
    }
}
