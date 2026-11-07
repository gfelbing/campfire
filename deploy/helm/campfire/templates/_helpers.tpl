{{/*
Common helpers: full name and standard labels.
*/}}

{{- define "campfire.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "campfire.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "campfire.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "campfire.labels" -}}
app.kubernetes.io/name: {{ include "campfire.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 }}
{{- end -}}

{{- define "campfire.selectorLabels" -}}
app.kubernetes.io/name: {{ include "campfire.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- /*
The namespace every chart resource lives in: the one the chart creates
(namespace.create: true) or the release namespace.
*/ -}}
{{- define "campfire.namespace" -}}
{{- if .Values.namespace.create -}}
{{- .Values.namespace.name -}}
{{- else -}}
{{- .Release.Namespace -}}
{{- end -}}
{{- end -}}
