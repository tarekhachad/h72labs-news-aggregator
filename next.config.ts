import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These load native binaries and data files by path at runtime, which a
  // bundler cannot follow — they have to stay external and be traced as files.
  serverExternalPackages: ["@xenova/transformers", "onnxruntime-node", "sharp"],

  // The digest route embeds articles locally, so its function needs the
  // vendored model and onnxruntime's Linux native runtime.
  //
  // The onnxruntime entry is required: the .node binding loads a sibling
  // libonnxruntime.so through dlopen, which the tracer cannot follow, and
  // without this entry the build succeeds and the first embed call fails in
  // production. The models entry is insurance rather than a requirement —
  // the tracer does find those files unaided here, but that is a property of
  // one tracer version and one build host, and if it ever stops holding the
  // failure is the same silent one.
  outputFileTracingIncludes: {
    "/api/digest": [
      "./models/**/*",
      "./node_modules/onnxruntime-node/bin/napi-v3/linux/**/*",
    ],
  },

  // onnxruntime-node ships every platform's binaries in one package. Only
  // Linux can execute on the deployment target, and a function has a 250MB
  // uncompressed ceiling that the full set eats into for nothing. Excluding
  // these affects the deployed bundle only — local dev reads node_modules
  // directly and is unaffected.
  outputFileTracingExcludes: {
    "/api/digest": [
      "./node_modules/onnxruntime-node/bin/napi-v3/darwin/**/*",
      "./node_modules/onnxruntime-node/bin/napi-v3/win32/**/*",
    ],
  },

  // The CSP deliberately has no script-src: Next's inline bootstrap scripts
  // need per-request nonces to pass one, which is a separate change. What it
  // does set stops framing (clickjacking), plugins, <base> hijacking and forms
  // posting off-site.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
