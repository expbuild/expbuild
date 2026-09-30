import type { Detail } from './api';

type Endpoint = { protocol: string; url: string };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

// Examples contain only validated endpoints and interactive credential prompts.
// Do not accept userinfo, query secrets or shell interpolation from endpoint data.
export function connectionExample(endpoint: Endpoint): string | null {
  let url: URL;
  try { url = new URL(endpoint.url); } catch { return null; }
  if (!url.hostname || url.username || url.password || url.search || url.hash || /\s/.test(endpoint.url)) return null;
  const reapi = endpoint.protocol === 'reapi';
  if (reapi ? !['grpc:', 'grpcs:'].includes(url.protocol) : !['http:', 'https:'].includes(url.protocol)) return null;
  if (reapi && url.pathname && url.pathname !== '/') return null;
  if (endpoint.protocol === 'gradle-http' && url.pathname !== '/cache/') return null;
  const address = quote(endpoint.url);
  if (reapi || endpoint.protocol === 'bazel-http') {
    return [
      "read -r -p '缓存用户名：' CACHE_USER",
      "read -r -s -p '缓存密码：' CACHE_PASSWORD",
      "printf '\\n'",
      'CACHE_AUTH="$(printf \'%s:%s\' "$CACHE_USER" "$CACHE_PASSWORD" | base64 | tr -d \'\\r\\n\')"',
      `bazel build //... --remote_cache=${address} --remote_header="Authorization=Basic $CACHE_AUTH"`,
      'unset CACHE_USER CACHE_PASSWORD CACHE_AUTH',
    ].join('\n');
  }
  if (endpoint.protocol === 'webdav') {
    return [
      "read -r -p '缓存用户名：' CACHE_USER",
      '# curl 将提示输入密码；此请求只查询目录信息。',
      `curl --fail --show-error --user "$CACHE_USER" --request PROPFIND --header 'Depth: 0' ${address}`,
      'unset CACHE_USER',
    ].join('\n');
  }
  if (endpoint.protocol === 'gradle-http') {
    return [
      `export EXPBUILD_CACHE_URL=${address}`,
      "read -r -p '缓存用户名：' EXPBUILD_CACHE_USER",
      "read -r -s -p '缓存密码：' EXPBUILD_CACHE_PASSWORD",
      "printf '\\n'",
      'export EXPBUILD_CACHE_USER EXPBUILD_CACHE_PASSWORD',
      'CACHE_INIT="$(mktemp)"',
      "trap 'rm -f \"$CACHE_INIT\"; unset EXPBUILD_CACHE_URL EXPBUILD_CACHE_USER EXPBUILD_CACHE_PASSWORD CACHE_INIT' EXIT",
      "cat >\"$CACHE_INIT\" <<'GRADLE_INIT'",
      'import org.gradle.caching.http.HttpBuildCache',
      'gradle.settingsEvaluated {',
      '  buildCache {',
      '    remote<HttpBuildCache> {',
      '      url = uri(System.getenv("EXPBUILD_CACHE_URL"))',
      '      credentials {',
      '        username = System.getenv("EXPBUILD_CACHE_USER")',
      '        password = System.getenv("EXPBUILD_CACHE_PASSWORD")',
      '      }',
      '      isPush = System.getenv("CI") == "true"',
      '    }',
      '  }',
      '}',
      'GRADLE_INIT',
      'gradle -I "$CACHE_INIT" --build-cache build',
    ].join('\n');
  }
  return null;
}

export function ConnectionInfo({ detail }: { detail: Detail }) {
  const ready = detail.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True' &&
    c.observedGeneration !== undefined && String(c.observedGeneration) === detail.revision?.split(':').at(-1));
  const available = detail.spec?.desiredState === 'Running' && ready && !['deleted', 'detached', 'deleting', 'pending'].includes(detail.lifecycle);
  const examples = available ? (detail.status?.endpoints ?? []).flatMap(endpoint => {
    const text = connectionExample(endpoint);
    return text ? [{ ...endpoint, text }] : [];
  }) : [];
  return <details>
    <summary>客户端连接指引</summary>
    {!available ? <p>当前配置尚未确认就绪，恢复运行并就绪后显示连接示例。</p> : !examples.length ?
      <p>当前端点尚无匹配的客户端示例。</p> : <>
        <p>在 Bash 终端运行。使用创建或轮换时保存的实例凭据；示例不包含实际密码。</p>
        <p>{detail.spec?.access?.exposure === 'Gateway' ? '客户端需要能够解析实例域名，并信任入口 TLS 证书。' : '这些地址仅供集群内部访问，请在可访问该服务的构建环境执行。'}</p>
        {examples.map((example, index) => <div key={`${example.protocol}-${index}`}>
          <h4>{example.protocol}</h4>
          {(example.protocol === 'reapi' || example.protocol === 'bazel-http') && <p>在 Bazel 项目目录执行，将 //... 替换为需要构建的目标。该配置使用远程缓存，不启用远程执行。</p>}
          {example.protocol === 'gradle-http' && <p>在 Gradle 项目目录执行。仅当 CI=true 时向远程缓存上传；开发机默认只读取。请确保客户端信任入口 TLS 证书。</p>}
          <pre style={{ overflowX: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}><code>{example.text}</code></pre>
        </div>)}
      </>}
  </details>;
}
