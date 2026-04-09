import Mime from "@effect/platform-node/Mime";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import { resolveAttachmentPathById } from "./attachmentStore";
import { ServerConfig } from "./config";
import {
  captureArtifactScreenshot,
  getArtifactPath,
  listArtifacts,
} from "./design/artifactStorage";
import {
  hasDesignBridge,
  invokeDesignBridge,
  DESIGN_BRIDGE_ROUTE,
  type DesignBridgeAction,
} from "./design/designBridge";
import {
  hasSharedChatBridge,
  invokeSharedChatBridge,
  SHARED_CHAT_BRIDGE_ROUTE,
} from "./discussion/sharedChatBridge";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver";

const PROJECT_FAVICON_CACHE_CONTROL = "public, max-age=3600";
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;

export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawRelativePath = url.value.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }),
);

export const projectFaviconRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      return HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
        },
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }),
);

const SharedChatBridgeRequest = Schema.Struct({
  token: Schema.String,
  message: Schema.String,
});

class SharedChatBridgeHttpError extends Error {
  readonly _tag = "SharedChatBridgeHttpError";
}

export const sharedChatBridgeRouteLayer = HttpRouter.add(
  "POST",
  SHARED_CHAT_BRIDGE_ROUTE,
  Effect.gen(function* () {
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const request = yield* HttpServerRequest.schemaBodyJson(SharedChatBridgeRequest);

    if (config.authToken) {
      const authorizationHeader = httpRequest.headers.authorization;
      if (authorizationHeader !== `Bearer ${config.authToken}`) {
        return HttpServerResponse.text("Unauthorized shared chat bridge request", { status: 401 });
      }
    }

    if (!hasSharedChatBridge(request.token)) {
      return HttpServerResponse.jsonUnsafe(
        {
          content: "Shared chat bridge token was not found.",
          success: false,
        },
        { status: 404 },
      );
    }

    const result = yield* Effect.tryPromise({
      try: () =>
        invokeSharedChatBridge({
          token: request.token,
          message: request.message,
        }),
      catch: (cause) =>
        new SharedChatBridgeHttpError(
          cause instanceof Error ? cause.message : `Shared chat bridge failed: ${String(cause)}.`,
        ),
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          content: error.message,
          success: false,
        }),
      ),
    );

    return HttpServerResponse.jsonUnsafe(result, {
      status: result.success ? 200 : 500,
    });
  }),
);

const DESIGN_ARTIFACT_ROUTE_PREFIX = "/api/internal/design/artifacts";

export const designArtifactRouteLayer = HttpRouter.add(
  "GET",
  `${DESIGN_ARTIFACT_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawPath = url.value.pathname.slice(DESIGN_ARTIFACT_ROUTE_PREFIX.length);
    // Expect /<threadId>/<artifactId>.html
    const match = rawPath.match(/^\/([^/]+)\/([^/]+)\.html$/);
    if (!match || !match[1] || !match[2]) {
      return HttpServerResponse.text("Invalid artifact path", { status: 400 });
    }

    const threadId = match[1];
    const artifactId = match[2];

    // Reject path traversal
    if (threadId.includes("..") || artifactId.includes("..")) {
      return HttpServerResponse.text("Invalid artifact path", { status: 400 });
    }

    const filePath = getArtifactPath(config.artifactsDir, threadId, artifactId);
    if (!filePath) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      contentType: "text/html; charset=utf-8",
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }),
);

const DESIGN_ARTIFACT_LIST_ROUTE_PREFIX = "/api/internal/design/artifact-list";

export const designArtifactListRouteLayer = HttpRouter.add(
  "GET",
  `${DESIGN_ARTIFACT_LIST_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawPath = url.value.pathname.slice(DESIGN_ARTIFACT_LIST_ROUTE_PREFIX.length);
    // Expect /<threadId>
    const match = rawPath.match(/^\/([^/]+)$/);
    if (!match || !match[1]) {
      return HttpServerResponse.text("Invalid thread ID", { status: 400 });
    }

    const threadId = match[1];
    if (threadId.includes("..")) {
      return HttpServerResponse.text("Invalid thread ID", { status: 400 });
    }

    const artifacts = listArtifacts(config.artifactsDir, threadId, { kind: "render" });
    return HttpServerResponse.jsonUnsafe(
      {
        artifacts: artifacts.map((entry) => ({
          artifactId: entry.artifactId,
          title: entry.title,
          description: entry.description,
          artifactPath: `${config.artifactsDir}/${threadId}/${entry.artifactId}.html`,
          renderedAt: entry.createdAt,
        })),
      },
      {
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
      },
    );
  }),
);

class ScreenshotCaptureHttpError extends Error {
  readonly _tag = "ScreenshotCaptureHttpError";
}

export const designArtifactScreenshotRouteLayer = HttpRouter.add(
  "POST",
  `${DESIGN_ARTIFACT_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawPath = url.value.pathname.slice(DESIGN_ARTIFACT_ROUTE_PREFIX.length);
    // Expect /<threadId>/<artifactId>/screenshot
    const match = rawPath.match(/^\/([^/]+)\/([^/]+)\/screenshot$/);
    if (!match || !match[1] || !match[2]) {
      return HttpServerResponse.text("Invalid screenshot path", { status: 400 });
    }

    const threadId = match[1];
    const artifactId = match[2];

    if (threadId.includes("..") || artifactId.includes("..")) {
      return HttpServerResponse.text("Invalid screenshot path", { status: 400 });
    }

    const screenshotPath = yield* Effect.tryPromise({
      try: () => captureArtifactScreenshot(config.artifactsDir, threadId, artifactId),
      catch: (cause) =>
        new ScreenshotCaptureHttpError(
          cause instanceof Error ? cause.message : `Screenshot capture failed: ${String(cause)}`,
        ),
    }).pipe(
      Effect.catch((error) => {
        console.warn("Screenshot capture failed:", error.message);
        return Effect.succeed(null as string | null);
      }),
    );

    return HttpServerResponse.jsonUnsafe(
      { screenshotPath },
      { status: 200, headers: { "Access-Control-Allow-Origin": "*" } },
    );
  }),
);

const DesignBridgeRequest = Schema.Struct({
  token: Schema.String,
  action: Schema.Record(Schema.String, Schema.Unknown),
});

class DesignBridgeHttpError extends Error {
  readonly _tag = "DesignBridgeHttpError";
}

export const designBridgeRouteLayer = HttpRouter.add(
  "POST",
  DESIGN_BRIDGE_ROUTE,
  Effect.gen(function* () {
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const request = yield* HttpServerRequest.schemaBodyJson(DesignBridgeRequest);

    if (config.authToken) {
      const authorizationHeader = httpRequest.headers.authorization;
      if (authorizationHeader !== `Bearer ${config.authToken}`) {
        return HttpServerResponse.text("Unauthorized design bridge request", { status: 401 });
      }
    }

    if (!hasDesignBridge(request.token)) {
      return HttpServerResponse.jsonUnsafe(
        { result: "Design bridge token was not found.", error: true },
        { status: 404 },
      );
    }

    const result = yield* Effect.tryPromise({
      try: () =>
        invokeDesignBridge({
          token: request.token,
          action: request.action as DesignBridgeAction,
        }),
      catch: (cause) =>
        new DesignBridgeHttpError(
          cause instanceof Error ? cause.message : `Design bridge failed: ${String(cause)}.`,
        ),
    }).pipe(Effect.catch((error) => Effect.succeed(JSON.stringify({ error: error.message }))));

    return HttpServerResponse.jsonUnsafe({ result }, { status: 200 });
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (config.devUrl) {
      return HttpServerResponse.redirect(config.devUrl.href, { status: 302 });
    }

    if (!config.staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(config.staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem
      .readFile(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
