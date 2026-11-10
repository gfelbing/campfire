#!/usr/bin/env python3
"""Generate docs/moq-sfu.md Phase 0 results from the Tier-1 matrix JSON.

Reads the per-scenario JSON (one file per scenario, plus soak-rss.json) from
the matrix output dir, evaluates the agreed gates and thresholds
(docs/moq-sfu.md §6), and writes docs/moq-spike-results.md.

Usage: gen_report.py <matrix-output-dir> [results-md-path]
"""
import json
import os
import sys

US_TO_MS = 1.0 / 1000.0


def load(out_dir, name):
    path = os.path.join(out_dir, name + ".json")
    if not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def subs(data):
    """Return the list of subscriber objects ({} if absent)."""
    if not data:
        return []
    return data.get("subscribers", [])


TRACK_KEY = {"a": "audio", "v": "video"}


def track_rows(data, track):
    """Per-subscriber scalars for one track, skipping errored subscribers."""
    rows = []
    key = TRACK_KEY.get(track, track)
    for s in subs(data):
        t = s.get(key)
        if isinstance(t, dict) and t.get("samples", 0) > 0:
            rows.append(t)
    return rows


def worst(rows, key):
    vals = [r[key] for r in rows if key in r]
    return max(vals) if vals else None


def first_frames(data, track):
    """Pool first_frame_ms across subscribers (scalars -> percentile-able)."""
    out = []
    key = TRACK_KEY.get(track, track)
    for s in subs(data):
        t = s.get(key)
        if isinstance(t, dict) and t.get("first_frame_ms") is not None:
            out.append(t["first_frame_ms"])
    return out


def pct(vals, q):
    if not vals:
        return None
    vals = sorted(vals)
    idx = min(int(q / 100.0 * len(vals)), len(vals) - 1)
    return vals[idx]


def ms(us):
    return None if us is None else us * US_TO_MS


# (label, pass_bool_or_None, detail)
def evaluate(out_dir):
    findings = []

    fan1 = load(out_dir, "fanout-1")
    fan4 = load(out_dir, "fanout-4")
    fan16 = load(out_dir, "fanout-16")
    fast = load(out_dir, "faststart-2s")
    loss0 = load(out_dir, "loss0-jitter100")
    loss5 = load(out_dir, "loss5-jitter100")
    loss20 = load(out_dir, "loss20-jitter100")
    soak = load(out_dir, "soak")
    rss = load(out_dir, "soak-rss")

    loss_dur_s = 30.0  # keep in sync with matrix.sh LOSS_DUR

    # --- G2: end-to-end fan-out works over the h3/quinn endpoint ---------
    def fan_ok(d):
        if not d:
            return False
        ss = subs(d)
        if not ss:
            return False
        for s in ss:
            if "error" in s:
                return False
            if s.get("audio", {}).get("samples", 0) < 1:
                return False
            if s.get("video", {}).get("samples", 0) < 1:
                return False
        return True

    g2_parts = {n: fan_ok(d) for n, d in
                [("fanout-1", fan1), ("fanout-4", fan4), ("fanout-16", fan16)]}
    g2 = all(g2_parts.values()) and any(g2_parts.values())
    findings.append(("G2", g2 if any(g2_parts.values()) else None,
                     "fan-out 1→1/4/16: " +
                     ", ".join(f"{k}={'ok' if v else 'FAIL/missing'}"
                               for k, v in g2_parts.items())))

    # --- T1: audio glass-to-glass (no loss) ------------------------------
    a = track_rows(fan4, "a")
    if a:
        t1_p50, t1_p95 = ms(worst(a, "p50_us")), ms(worst(a, "p95_us"))
        findings.append(("T1", t1_p50 <= 250 and t1_p95 <= 400,
                         f"audio p50={t1_p50:.0f}ms (≤250), p95={t1_p95:.0f}ms (≤400)"))
    else:
        findings.append(("T1", None, "no fanout-4 audio data"))

    # --- T2: video glass-to-glass + A/V skew (no loss) --------------------
    v = track_rows(fan4, "v")
    if a and v:
        t2_p50 = ms(worst(v, "p50_us"))
        # A/V skew per subscriber: |audio p50 - video p50|; take the worst.
        skews = [abs(sa["p50_us"] - sv["p50_us"]) * US_TO_MS for sa, sv in zip(a, v)]
        t2_skew = max(skews) if skews else None
        findings.append(("T2", t2_p50 <= 300 and (t2_skew or 0) <= 90,
                         f"video p50={t2_p50:.0f}ms (≤300), A/V skew={t2_skew:.0f}ms (≤90)"))
    else:
        findings.append(("T2", None, "no fanout-4 data"))

    # --- T3: keyframe fast-start (new subscriber first frame) -------------
    ff = first_frames(fast, "v")
    if ff:
        t3_p50, t3_p95 = pct(ff, 50), pct(ff, 95)
        findings.append(("T3", t3_p50 <= 500 and t3_p95 <= 1000,
                         f"first-frame p50={t3_p50:.0f}ms (≤500), p95={t3_p95:.0f}ms (≤1000)"))
    else:
        findings.append(("T3", None, "no faststart data"))

    # --- T4: 5% loss + 100ms jitter --------------------------------------
    a5 = track_rows(loss5, "a")
    if a5:
        t4_p95 = ms(worst(a5, "p95_us"))
        gaps_min = worst(a5, "gaps_gt_100ms") * (60.0 / loss_dur_s)
        findings.append(("T4", t4_p95 <= 600 and gaps_min <= 2,
                         f"audio p95={t4_p95:.0f}ms (≤600), gaps>100ms={gaps_min:.1f}/min (≤2)"))
    else:
        findings.append(("T4", None, "no loss5 data"))

    # --- T5: 20% loss -----------------------------------------------------
    a20, v20 = track_rows(loss20, "a"), track_rows(loss20, "v")
    if a20 and v20:
        t5_p95 = ms(worst(a20, "p95_us"))
        t5_gaps = worst(a20, "gaps_gt_100ms") * (60.0 / loss_dur_s)
        t5_freeze = worst(v20, "max_rx_gap_ms")
        ok = t5_p95 <= 1000 and t5_gaps <= 10 and (t5_freeze or 0) <= 2000
        findings.append(("T5", ok,
                         f"audio p95={t5_p95:.0f}ms (≤1000), gaps={t5_gaps:.1f}/min (≤10), "
                         f"max video freeze (rx-time)={t5_freeze:.0f}ms (≤2000)"))
    else:
        findings.append(("T5", None, "no loss20 data"))

    # --- T6: 10-min soak (RSS + no stall) --------------------------------
    if soak and rss:
        delta_mb = (rss["rss_after_kb"] - rss["rss_before_kb"]) / 1024.0
        stalls = []
        for tr in ("a", "v"):
            for r in track_rows(soak, tr):
                stalls.append(r.get("max_rx_gap_ms", 0))
        max_stall = max(stalls) if stalls else None
        # Post-fill growth from the 30 s RSS series: a one-time cache fill
        # plateaus, a leak keeps climbing (compare 2 min -> end).
        samples = rss.get("samples", [])
        steady = [s for s in samples if s[0] >= 120]
        tail_mb = None
        if len(steady) >= 2:
            (t0, k0), (t1, k1) = steady[0], steady[-1]
            if t1 > t0:
                tail_mb = (k1 - k0) / 1024.0 / ((t1 - t0) / 60.0)
        ok = delta_mb < 10 and (max_stall or 0) < 2000
        stall_str = "n/a" if max_stall is None else f"{max_stall:.0f}"
        detail = f"RSS +{delta_mb:.1f}MB (<10), max stall={stall_str}ms (<2000)"
        if tail_mb is not None:
            detail += f", 2-min->end growth {tail_mb:+.2f}MB/min"
        findings.append(("T6", ok, detail))
    else:
        findings.append(("T6", None, "soak not run (SOAK_DUR=0?)"))

    # --- T7: resubscribe first frame (proxy: late join) -------------------
    ff7 = first_frames(fast, "v")
    if ff7:
        t7_p50 = pct(ff7, 50)
        findings.append(("T7", t7_p50 <= 2000,
                         f"resubscribe/late-join first-frame p50={t7_p50:.0f}ms (≤2000)"))
    else:
        findings.append(("T7", None, "no faststart data"))

    # --- Tier-2-only gates (informational here) ---------------------------
    findings.append(("G1", None, "Tier 2 (browser codecs) — not measured here"))
    findings.append(("G3", None, "Tier 2 (AudioDecoder→WebAudio) — T6 is the Tier-1 proxy"))

    return findings, {
        "fanout-1": fan1, "fanout-4": fan4, "fanout-16": fan16,
        "faststart-2s": fast, "loss0-jitter100": loss0, "loss5-jitter100": loss5,
        "loss20-jitter100": loss20, "soak": soak, "soak-rss": rss,
    }


def fmt_track(t):
    if not t:
        return "—"
    return (f"p50 {t.get('p50_us', 0)/1000:.0f} / p95 {t.get('p95_us', 0)/1000:.0f} ms, "
            f"{t.get('samples', 0)} frames, max-gap {t.get('max_gap_ms', 0):.0f} ms, "
            f"max-stall {t.get('max_rx_gap_ms', 0):.0f} ms")


def scenario_table(name, data):
    lines = [f"### {name}", ""]
    if not data:
        lines.append("_not run_")
        lines.append("")
        return lines
    lines.append(f"negotiated: {data.get('negotiated_version')} · "
                 f"duration {data.get('duration_s', 0):.1f}s · "
                 f"client CPU {data.get('cpu_seconds', 0):.2f}s")
    lines.append("")
    lines.append("| sub | audio (p50/p95, n, max-gap, max-stall) | video (p50/p95, n, max-gap, max-stall) |")
    lines.append("|----|------------------------------|------------------------------|")
    for i, s in enumerate(subs(data)):
        if "error" in s:
            lines.append(f"| {i} | ERROR: {s['error']} | — |")
        else:
            lines.append(f"| {i} | {fmt_track(s.get('audio'))} | {fmt_track(s.get('video'))} |")
    lines.append("")
    return lines


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out_dir = sys.argv[1]
    results_path = sys.argv[2] if len(sys.argv) > 2 else \
        os.path.join(os.getcwd(), "docs", "moq-spike-results.md")

    findings, data = evaluate(out_dir)
    measured = [f for f in findings if f[1] is not None]
    passed = [f for f in measured if f[1]]
    failed = [f for f in measured if not f[1]]
    verdict = "GO" if failed == [] and any(f[0] == "G2" and f[1] for f in findings) \
        else ("NO-GO" if measured else "INCOMPLETE")

    md = []
    md.append("# MoQ SFU spike — Phase 0 results (Tier 1)\n")
    md.append("_Generated by `tools/moq-spike/gen_report.py` from the matrix JSON. "
              "Do not edit by hand._\n")
    md.append(f"**Verdict: {verdict}** — {len(passed)} passed, "
              f"{len(failed)} failed, {len(measured) - len(passed) - len(failed)} "
              f"not measured, of {len(measured)} measurable.\n")
    md.append("Tier 1 = Rust spike client + SFU over h3/quinn WebTransport, "
              "fake media, no browser. Loss in a private `unshare -rn` netns "
              "(host `lo` untouched). G1/G3 are Tier-2 (browser) gates.\n")

    md.append("## Gates & thresholds\n")
    md.append("| check | result | detail |")
    md.append("|-------|--------|--------|")
    for label, ok, detail in findings:
        res = {True: "PASS", False: "**FAIL**", None: "n/a"}[ok]
        md.append(f"| {label} | {res} | {detail} |")
    md.append("")

    md.append("## Scenarios\n")
    for name in ["fanout-1", "fanout-4", "fanout-16", "faststart-2s",
                 "loss0-jitter100", "loss5-jitter100", "loss20-jitter100", "soak"]:
        md.extend(scenario_table(name, data.get(name)))
    if data.get("soak-rss"):
        r = data["soak-rss"]
        md.append(f"### soak RSS\n\nbefore {r['rss_before_kb']} kB → after "
                  f"{r['rss_after_kb']} kB "
                  f"({(r['rss_after_kb'] - r['rss_before_kb']) / 1024.0:+.1f} MB)\n")
        samples = r.get("samples")
        if samples:
            md.append("RSS over the soak (s, kB): "
                      + " · ".join(f"t={t} {k} kB" for t, k in samples)
                      + "\n")

    md.append("## Notes\n")
    md.append("- Latency = glass-to-glass on one host (shared `Instant` clock, "
              "send-stamp in payload); the Lite02 wire carries no frame timestamp.")
    md.append("- `max-gap` = largest gap in send-stamp space (missing frames); "
              "`max-stall` = largest gap in receive time between consecutive "
              "frames in send order (what a consumer presents as a freeze).")
    md.append("- Loss scenarios: netem on `lo` egress in a private netns, "
              "`delay 100ms 30ms distribution normal` (+ loss %); both directions.")
    md.append("- Per-direction and SFU CPU are informational only (README §6), not gating.")
    md.append("- G2 is the Tier-1 gate; G1 (codecs) and G3 (audio underrun) need "
              "the Tier-2 headless-browser run.")
    md.append("")

    with open(results_path, "w") as f:
        f.write("\n".join(md))
    print(f"wrote {results_path} (verdict {verdict})")
    # Go/no-go is the one manual decision (docs/moq-sfu.md §6); the generator
    # reports it, it does not gate the build.
    sys.exit(0)


if __name__ == "__main__":
    main()
