# Per-instance domain ingress (Gateway API)

Status: adapter code, API server contracts, and isolated-cluster protocol acceptance with a pinned Envoy Gateway have passed. Disabled by default; production deployments still need to validate DNS, ingress load balancing, CNI, and storage environments.

## Resources and responsibilities

The deployer installs Gateway API Standard CRDs (code contracts pin v1.2.1), a controller compatible with HTTPRoute/GRPCRoute, and manages the shared Gateway, DNS, and TLS certificates. The expbuild Operator creates only routes and minimal NetworkPolicies in each instance's namespace; it does not create or modify the shared Gateway, certificates, DNS, or GatewayClass.

Instance exposure can be `ClusterInternal` or `Gateway`. Once enabled in the management API with `GATEWAY_ENABLED=true`, the template catalog advertises the available modes and the UI shows the per-instance domain option. The default is ClusterInternal. PATCH accepts a complete configuration, so clients must preserve the current exposure to avoid accidentally reverting to internal access.

External addresses are `http-<CR-UID>.<baseDomain>` and `grpc-<CR-UID>.<baseDomain>`, using HTTPS and gRPC TLS respectively. Domains bind to the immutable CR UID assigned by the cluster, preventing routing conflicts from manually written CRs with duplicate instanceId values or names reused across namespaces. Updates and pause/resume preserve the UID; deletion and recreation produce a new address. WebDAV has only an HTTP route. Bazel HTTP and REAPI routes point to ports 8080 and 9092 of the same instance Service; the latter declares `kubernetes.io/h2c`.

The [Gateway API GRPCRoute specification](https://gateway-api.sigs.k8s.io/reference/api-types/grpcroute/) recommends different hostnames for HTTP and gRPC; this adapter follows that approach. Instances continue to use native engine authentication. The Gateway should preserve Authorization and the original request method and path, without additional caching or rewriting.

## Configuration example

The following illustrates shared resources maintained by the deployer; the expbuild chart does not create them automatically:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: caches
  namespace: edge
spec:
  gatewayClassName: your-approved-gateway-class
  listeners:
    - name: caches-https
      protocol: HTTPS
      port: 443
      hostname: '*.cache.example.com'
      tls:
        mode: Terminate
        certificateRefs:
          - name: cache-wildcard-tls
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              app.kubernetes.io/managed-by: expbuild
        kinds:
          - group: gateway.networking.k8s.io
            kind: HTTPRoute
          - group: gateway.networking.k8s.io
            kind: GRPCRoute
```

The certificate Secret resides in the Gateway's namespace and covers `*.cache.example.com`; the corresponding wildcard DNS record points to the ingress. See the [official documentation](https://gateway-api.sigs.k8s.io/guides/user-guides/tls/) for Gateway API TLS rules. The ingress may use a private address; public Internet access is not required.

Corresponding Helm values:

```yaml
gateway:
  enabled: true
  name: caches
  namespace: edge
  sectionName: caches-https
  baseDomain: cache.example.com
  controllerName: your.example.com/gateway-controller
  dataPlaneNamespace: edge-data-plane
```

`controllerName` must be the actual controller name used by the chosen GatewayClass; the example does not identify a runnable controller. `dataPlaneNamespace` is the namespace of the Pods that actually forward traffic and may differ from the namespace of the Gateway object or controller. The deployer must label these data-plane Pods with `cache.expbuild.io/gateway=true` and ensure the label survives recreation.

Each external instance's NetworkPolicy requires both the source namespace name and Pod label to match and opens only the ports required by that template. It operates alongside existing project policies and does not revoke existing client or control-plane permissions. If the network plugin does not enforce NetworkPolicy, these policies cannot be used to claim traffic isolation.

## Readiness and cleanup

The Operator requires the selected listener to use 443/HTTPS/TLS Terminate, with the required Accepted/Programmed/ResolvedRefs conditions for the current generation of the Gateway and listener. Each route must also match its parent, namespace, sectionName, controllerName, and current-generation Accepted/ResolvedRefs conditions. Backends must still pass the existing authenticated protocol probes.

In Gateway mode, Ready/EndpointReady indicates that backend and route configurations have been accepted. `ExternalReachability=Unknown, reason=NotProbed` explicitly means external DNS, certificate trust, and client reachability have not been verified; these conditions are not proof of complete external availability.

When pausing, switching back to internal access, or deleting an instance, the Operator first deletes ownership-matched HTTPRoutes, GRPCRoutes, and ingress NetworkPolicies before continuing. Deletion uses UID/resourceVersion preconditions and refuses to adopt or delete resources belonging to other instances. A dedicated gateway-cleanup finalizer is written before route creation and removed only after route absence is confirmed; failed cleanup retains the marker.

Before disabling ingress configuration, switch Gateway instances back to internal access or delete them. After it is disabled, the Operator no longer watches route changes, but retains cleanup permissions so instances with existing markers can still revoke access on deletion. Do not uninstall Gateway API CRDs first: missing APIs make safe cleanup fail and block normal completion. There is controller convergence time between deleting route objects and the proxy actually ceasing to forward traffic; this must be validated against a real data plane.

## Completed isolated-cluster acceptance

[Real-cluster CI on 2026-09-30](https://github.com/expbuild/expbuild/actions/runs/36669207282) passed at commit `ea1aaa7`. It used Envoy Gateway v1.8.5 and Envoy v1.38.4 with pinned chart SHA256 and image digests; see [testing instructions](testing.md) for the reproduction entry point.

- Actual shared HTTPS listener and cross-namespace HTTPRoute/GRPCRoute acceptance.
- Temporary CA, wildcard certificate, and real hostname/SNI validation; incorrect hostnames and untrusted certificates are rejected.
- WebDAV authentication, 16 MiB PUT/GET, MKCOL/PROPFIND/LOCK, rejection of deletion without a token, and successful deletion with the specified resource's lock token.
- External WebDAV access stops on pause and original data can be read after resume; rotation rejects the old password and allows the new password to read original data; deletion revokes external ingress.
- bazel-remote v2.6.2 digest-pinned image, non-root UID/fsGroup, read-only root filesystem, and real PVC; gRPC TLS capabilities, FindMissingBlobs, chunked 8 MiB ByteStream upload/download, and Bazel HTTP CAS.
- After REAPI and HTTP credential rotation, the old password is rejected and the new password reads original data; HTTPRoute/GRPCRoute cleanup follows deletion.

Traffic reaches a real Gateway TLS listener through local port forwarding, without bypassing the proxy or certificate validation. This does not validate public DNS or an external load balancer, or establish production CSI compatibility.

## Outstanding qualification

- Allowed/denied sources under a real CNI, and production network and DNS configuration.
- Real Bazel build clients, ActionCache, compression, and concurrent client behavior.
- WebDAV redirects, MOVE/COPY, and broader client compatibility.
- Ingress timeouts, oversized requests, and load tests; 16 MiB/8 MiB are verified samples, not capacity limits or throughput promises.
- Actual RPC rejection after REAPI deletion; current deletion checks confirm route-object cleanup, while WebDAV has a separate data-plane revocation assertion.
