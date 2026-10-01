FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY operator/go.mod operator/go.sum ./
RUN go mod download
COPY operator .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/operator ./cmd/operator
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/webdav-stats ./cmd/webdav-stats

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/operator /operator
COPY --from=build /out/webdav-stats /webdav-stats
USER 65532:65532
EXPOSE 8081
ENTRYPOINT ["/operator"]
