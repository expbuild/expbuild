{{- define "expbuild.name" -}}
{{- printf "%s-expbuild" .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}
{{- define "expbuild.labels" -}}
app.kubernetes.io/name: expbuild
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
{{- end -}}
{{- define "expbuild.podSecurity" -}}
runAsNonRoot: true
seccompProfile:
  type: RuntimeDefault
{{- end -}}
{{- define "expbuild.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}
