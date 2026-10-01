import { t } from "./i18n";
export class APIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set("Content-Type", "application/json");
  const csrf = sessionStorage.getItem("expbuild-csrf");
  if (csrf && options.method && options.method !== "GET")
    headers.set("x-csrf-token", csrf);
  const response = await fetch(`/v1${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401)
      window.dispatchEvent(new Event("expbuild-session-expired"));
    const details = body.issues
      ?.map(
        (x: { path: string[]; message: string }) =>
          `${x.path.join(".")}: ${x.message}`,
      )
      .join("; ");
    throw new APIError(
      response.status,
      details ||
        body.error ||
        t("请求失败（{value0}）", { value0: response.status }),
    );
  }
  return body as T;
}
export type User = { id: string; email: string; platform_admin: boolean };
export type Project = {
  id: string;
  name: string;
  state: string;
  role?: string;
};
export type TemplateName = string;
export type Template = {
  name: TemplateName;
  version: string;
  protocols: string[];
  exposures?: ("ClusterInternal" | "Gateway")[];
  inputSchema?: {
    properties?: Record<string, { minimum?: number; maximum?: number }>;
  };
  capabilities: {
    policyApplyMode?: "restart" | "unsupported";
    capacity: boolean;
    statistics: boolean;
    lookupHistory?: boolean;
    lru: boolean;
    ttl: boolean;
  };
};
export const templateLabel = (name: string) =>
  name === "webdav-apache"
    ? "WebDAV / HTTP"
    : name === "bazel-remote"
      ? "REAPI / Bazel HTTP"
      : name === "gradle-http"
        ? "Gradle HTTP"
        : name;
export type Instance = {
  template_name: string;
  id: string;
  display_name: string;
  lifecycle: string;
  resource_name: string;
};
export type Operation = {
  target_generation: string | number | null;
  updated_at: string;
  id: string;
  instance_id: string | null;
  kind: string;
  state: string;
  error_code: string | null;
  created_at: string;
};
export type Input = {
  exposure: "ClusterInternal" | "Gateway";
  template: TemplateName;
  name: string;
  storageGiB: number;
  cacheGiB: number;
  cpuMillis: number;
  memoryMiB: number;
  desiredState: "Running" | "Suspended";
  deletionPolicy: "Retain" | "Delete";
};
export type Detail = {
  id: string;
  name: string;
  lifecycle: string;
  revision: string | null;
  template?: TemplateName;
  templateVersion?: string | null;
  capabilities?: Template["capabilities"] | null;
  spec: null | {
    templateRef: { name: TemplateName; version: string };
    access?: { exposure: "ClusterInternal" | "Gateway" };
    desiredState: Input["desiredState"];
    storage: { capacity: string; deletionPolicy: Input["deletionPolicy"] };
    eviction: { maxCacheGiB: number };
    resources: { limits: { cpu: string; memory: string } };
  };
  status: null | {
    endpoints?: { protocol: string; url: string }[];
    conditions?: {
      type: string;
      status: string;
      reason: string;
      message?: string;
      observedGeneration?: number;
    }[];
  };
};
export const stateNames: Record<string, string> = {
  pending: "等待处理",
  applying: "提交中",
  reconciling: "部署中",
  succeeded: "已完成",
  failed: "失败",
  superseded: "配置已被替代",
  ready: "可用",
  active: "已创建",
  deleting: "删除中",
  deleted: "已删除",
  detached: "卷已保留",
};
export const operationNames: Record<string, string> = {
  "project.create": "初始化项目",
  "volume.delete": "清理保留卷",
  "instance.create": "创建实例",
  "instance.reclaim": "领回保留卷",
  "instance.update": "更新实例",
  "instance.delete": "删除实例",
  "instance.rotate": "轮换凭据",
};
