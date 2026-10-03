# expbuild management UI

The new React + TypeScript management console is deployed on the same origin as `apps/admin-api`.

It currently supports login, session restoration, logout, project creation/switching, instance lists and creation,
resource and eviction-capacity configuration, pause/resume, deletion confirmation, connection endpoints, and operation progress,
as well as user creation/activation/deactivation, changing your own password, administrator password resets, adding members by email, changing roles/removing members, project audit records, and cache credential rotation.
The actions available to administrators, maintainers, and read-only users correspond to backend permissions; the API makes the final authorization decision.

## Information architecture and internationalization

The console uses a fixed sidebar, a project switcher at the top, and separate feature pages. Project pages include Overview, Cache instances, Operations, Resources and quotas, Members and permissions, and Audit records; platform user management has a separate entry point. The API still enforces permissions, while the UI shows available actions by role. Pages use hash routing so refresh and browser back/forward navigation restore the project and feature page.

The instance list supports searches by name/resource identifier and filters by protocol and management state. Creation uses a dialog, while instance details use a drawer; the native dialog provides focus containment, Escape-to-close, and focus restoration on close. Closing is disabled while creation or credential changes are being submitted to avoid losing a one-time password. Narrow screens use expandable navigation and horizontally scrolling tables.

- The current UI languages are English and Simplified Chinese. The user's saved choice takes precedence, followed by the browser's Simplified Chinese preference; other languages fall back to English.
- The language preference is saved as `expbuild-locale` in `localStorage`; switching still works for the current page when storage is disabled. Switching languages does not reload the page or reset forms; the page's `lang` and title update together.
- `src/messages.ts` centrally stores the Chinese source strings and English translations. Use `t()` for new copy and interpolate parameters into complete sentences for dynamic content; `i18n.test.ts` checks static-string coverage and parameter consistency.
- Dates and numbers use `Intl` formatting for the selected language; dates use the browser's local time zone. Protocols, resource IDs, endpoints, user input, and backend diagnostic codes retain their original values.
- Overview shows only data supported by existing endpoints; operation summaries cover the latest 100 records. A failed first collection appears as unknown, rather than being treated as zero usage or a healthy service.

## Running locally

Run from the repository root:

```sh
npm ci
npm run dev --workspace @expbuild/admin-api
npm run dev --workspace @expbuild/admin-web
```

Set the API's `APP_ORIGIN` to `http://localhost:5173` and use that address in the browser as well.
Vite proxies `/v1` to local port 3001, preserving the original Origin.
The API requires PostgreSQL, Kubernetes configuration, and an operation-encryption key; see its README.

```sh
npm run build --workspace @expbuild/admin-web
npm test --workspace @expbuild/admin-web
```

Build output is placed in `dist`. Production deployments must serve static files and the `/v1` reverse proxy through the same entry point;
do not use the Vite development server in production.

## Behavior and boundaries

- Authentication sessions are stored in HttpOnly cookies; the CSRF token uses the current tab's sessionStorage.
  A new tab without a CSRF token requires login again. Instance connection passwords are kept only in component memory.
- Retrying the same failed form request reuses its idempotency key; changing the form contents generates a new key.
- Edits use the configuration version captured when the form was opened; background refreshes do not upgrade a stale form to write against a new version.
- Instance lifecycle and service Ready state are displayed separately; a service that is not ready is not shown as ready.
- The template catalog comes from the API's enabled configuration. The UI supports the existing REAPI/Bazel, Gradle HTTP, and WebDAV templates and displays statistics and configuration according to actual template capabilities. WebDAV retains its existing engine capabilities; this change only adjusts the management UI's layout and copy. Email password recovery is not implemented. Project lists show at most 200 entries, and operation lists at most 100.
- Component tests use a mock API and cannot replace real-browser and Kubernetes integration testing.

Instance details show engine cache usage, capacity, entry count, and collection time. Collection failures retain the latest result and mark it unavailable; polling stops for paused/deleted instances. These statistics do not represent disk usage for the entire PVC.

Browser tests run the real production build, management API, and isolated PostgreSQL, with a test adapter for Kubernetes. `tests/browser/international.spec.ts` covers English fallback, language switching and persistence, preservation of form state, page routing, search and filtering, drawer focus, prevention of closing during submission, and mobile layouts, and outputs page screenshots. It does not replace testing against a real Kubernetes cluster.
