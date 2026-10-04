FROM golang:1.27.1-bookworm AS build
WORKDIR /src
COPY operator/go.mod operator/go.sum ./
RUN go mod download
COPY operator .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/turborepo-cache ./cmd/turborepo-cache

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/turborepo-cache /turborepo-cache
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["/turborepo-cache"]
