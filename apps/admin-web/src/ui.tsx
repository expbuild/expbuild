import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { t, useLocale, setLocale, type Locale } from "./i18n";

export type Section =
  "overview" | "instances" | "operations" | "resources" | "members" | "audit";
export const sections: {
  id: Section;
  label: string;
  description: string;
  admin?: boolean;
}[] = [
  {
    id: "overview",
    label: "项目概览",
    description: "查看项目资源、最近活动与待处理事项。",
  },
  {
    id: "instances",
    label: "缓存实例",
    description: "管理团队的缓存服务、资源配置与连接方式。",
  },
  {
    id: "operations",
    label: "操作记录",
    description: "跟踪配置变更、部署进度与失败操作。",
  },
  {
    id: "resources",
    label: "资源与配额",
    description: "核对资源归属，管理项目的容量与资源上限。",
  },
  {
    id: "members",
    label: "成员权限",
    description: "为项目成员分配访问与管理权限。",
    admin: true,
  },
  {
    id: "audit",
    label: "审计记录",
    description: "查看项目变更及其操作者。",
    admin: true,
  },
];
export function useRoute() {
  const read = () => {
    const match = /^#\/projects\/([^/]+)\/(\w+)$/.exec(window.location.hash);
    return {
      project: match?.[1] ?? "",
      section: (sections.find((s) => s.id === match?.[2])?.id ??
        "instances") as Section,
      users: window.location.hash === "#/users",
    };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const change = () => setRoute(read());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  return route;
}
export function LanguageSelect() {
  const locale = useLocale();
  return (
    <label className="language-select">
      <Icon name="globe" />
      <span className="sr-only">Language / 语言</span>
      <select
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        <option value="en">English</option>
        <option value="zh-CN">简体中文</option>
      </select>
    </label>
  );
}
export function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    overview: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    instances: (
      <>
        <rect x="3" y="3" width="18" height="7" rx="2" />
        <rect x="3" y="14" width="18" height="7" rx="2" />
        <path d="M7 6.5h.01M7 17.5h.01M15 6.5h3M15 17.5h3" />
      </>
    ),
    operations: (
      <>
        <path d="M3 12h4l3-8 4 16 3-8h4" />
      </>
    ),
    resources: (
      <>
        <path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" />
      </>
    ),
    members: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2" />
      </>
    ),
    audit: (
      <>
        <rect x="5" y="3" width="14" height="18" rx="2" />
        <path d="M9 8h6M9 12h6M9 16h4" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <ellipse cx="12" cy="12" rx="4" ry="9" />
        <path d="M3 12h18" />
      </>
    ),
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  };
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.instances}
    </svg>
  );
}
export function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        e
      </span>
      expbuild<span className="brand-tag">Console</span>
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  wide = false,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const node = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    node.showModal();
    return () => {
      node.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "dialog drawer" : "dialog"}
      aria-labelledby={id}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="dialog-header">
        <h2 id={id}>{title}</h2>
        <div className="dialog-tools">
          <LanguageSelect />
          <button
            type="button"
            className="icon-button"
            aria-label={t("关闭")}
            onClick={onClose}
            disabled={busy}
          >
            <Icon name="close" />
          </button>
        </div>
      </div>
      <div className="dialog-content">{children}</div>
    </dialog>
  );
}
