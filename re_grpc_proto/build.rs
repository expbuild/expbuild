/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is dual-licensed under either the MIT license found in the
 * LICENSE-MIT file in the root directory of this source tree or the Apache
 * License, Version 2.0 found in the LICENSE-APACHE file in the root directory
 * of this source tree. You may select, at your option, one of the
 * above-listed licenses.
 */

use std::io;

fn main() -> io::Result<()> {
    let proto_files = &[
        "proto/build/bazel/remote/execution/v2/remote_execution.proto",
        "proto/build/bazel/semver/semver.proto",
        "proto/google/api/annotations.proto",
        "proto/google/api/client.proto",
        "proto/google/api/http.proto",
        "proto/google/bytestream/bytestream.proto",
        "proto/google/longrunning/operations.proto",
        "proto/google/rpc/code.proto",
        "proto/google/rpc/status.proto",
    ];

    tonic_build::configure()
        .build_server(true)
        .out_dir("src/")
        .compile_protos(
            proto_files, 
            &["proto/"]
        )?;
    Ok(())
}
