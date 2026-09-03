// 静态路由扫描（契约保护网的地基，OpenAPI 快照与鉴权矩阵共用）。
//
// 设计约束（见 docs/refactor/go-migration-adr.md §6、任务 C/D 规格）：
//   1. 不启动 Nest 应用、不连数据库——SwaggerModule.createDocument 需要完整
//      AppModule（PrismaService.onModuleInit 会 $connect），因此改为直接
//      require 控制器类并读取装饰器写入的 Reflect 元数据。
//   2. 确定性：输出按 (path, method, handler) 排序，不含时间戳/绝对路径。
//   3. fail-closed：任何端点缺权限元数据都标记为 missing（矩阵检查会失败），
//      与运行时 PermissionsGuard 的 fail-closed 语义一致。
//
// 读取的元数据键与 @nestjs/common constants 保持一致：
//   CONTROLLER_WATERMARK / PATH_METADATA / METHOD_METADATA /
//   HEADERS_METADATA / SSE_METADATA / GUARDS_METADATA 以及本仓库自定义键
//   isPublic / allowAuthenticated / permissions。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// 装饰器元数据写入发生在类定义时——必须先加载 reflect-metadata。
import "reflect-metadata";

export const PATH_METADATA = "path";
export const METHOD_METADATA = "method";
export const HEADERS_METADATA = "__headers__";
export const SSE_METADATA = "__sse__";
export const GUARDS_METADATA = "__guards__";
export const CONTROLLER_WATERMARK = "__controller__";
export const ROUTE_ARGS_METADATA = "__routeArguments__";
export const PARAMTYPES_METADATA = "design:paramtypes";
export const IS_PUBLIC_KEY = "isPublic";
export const ALLOW_AUTHENTICATED_KEY = "allowAuthenticated";
export const PERMISSIONS_KEY = "permissions";

const REQUEST_METHOD_NAMES = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "ALL",
  "OPTIONS",
  "HEAD",
] as const;

export type HttpMethod = (typeof REQUEST_METHOD_NAMES)[number];

export interface EndpointAuth {
  /** @Public()（handler 或 class 级）→ 跳过 JWT 与权限。 */
  isPublic: boolean;
  /** @AllowAuthenticated() → 仅 JWT，无权限要求。 */
  allowAuthenticated: boolean;
  /** @Permissions / @PermissionsAll 的归一化结果。 */
  permissions: string[];
  permissionsMode: "any" | "all" | null;
  /** class 级或 handler 级 @UseGuards 的守卫类名列表。 */
  guards: string[];
  /** handler 体内调用 assertPlatformAdmin/isPlatformAdmin 的静态启发式标记。 */
  platformAdminInHandler: boolean;
}

export interface RouteParam {
  /** @Param / @Query / @Body 的参数类型标签。 */
  kind: "param" | "query" | "body";
  /** 装饰器数据（@Param("id") → "id"；@Body() → null）。 */
  name: string | null;
  /** 参数的 TS 类型名（design:paramtypes），用于 OpenAPI 引用。 */
  typeName: string | null;
}

export interface EndpointInfo {
  /** 排序后的方法名（GET/POST/...）。 */
  method: string;
  /** 完整路径（含 /api 全局前缀；排除 admin/queues*）。 */
  path: string;
  controller: string;
  handler: string;
  /** 源码位置（仓库相对路径）。 */
  source: string;
  auth: EndpointAuth;
  /** @Header() 装饰器写入的头（如 Cache-Control）。 */
  headers: Record<string, string>;
  isSse: boolean;
  /** 路径参数（:id 形式来自 handler path 元数据）。 */
  pathParams: string[];
  /** @Param/@Query/@Body 装饰器参数。 */
  routeParams: RouteParam[];
}

export interface ScanOptions {
  /** apps/api 的根目录（默认：本文件所在目录的上级）。 */
  apiRoot: string;
  /** 全局 REST 前缀（main.ts setGlobalPrefix）。 */
  globalPrefix: string;
}

export interface ScanResult {
  endpoints: EndpointInfo[];
  controllerCount: number;
  errors: string[];
}

function walkControllers(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      walkControllers(full, acc);
    } else if (entry.endsWith(".controller.ts") && !entry.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

interface LoadedController {
  name: string;
  classPath: string;
  basePath: string;
  // 装饰器元数据是 unknown 形状，逐键归一化后使用。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target: any;
}

function loadController(file: string): LoadedController | null {
  // require TS 源：本脚本经 tsx 运行（scripts 内其他脚本同模式）。
  // 需要按路径动态加载并读取装饰器元数据。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(file) as Record<string, unknown>;
  for (const exportedValue of Object.values(mod)) {
    if (
      typeof exportedValue === "function" &&
      Reflect.getMetadata(CONTROLLER_WATERMARK, exportedValue) === true
    ) {
      const target = exportedValue as new (...args: never[]) => unknown;
      const basePath = String(Reflect.getMetadata(PATH_METADATA, target) ?? "");
      return {
        name: target.name,
        classPath: file,
        basePath,
        target,
      };
    }
  }
  return null;
}

function normalizePermissions(value: unknown): {
  permissions: string[];
  mode: "any" | "all" | null;
} | null {
  if (!value) {
    return null;
  }
  if (Array.isArray(value) && value.every((p) => typeof p === "string")) {
    return { permissions: value as string[], mode: "any" };
  }
  if (typeof value !== "object") {
    return null;
  }
  const requirement = value as { permissions?: unknown; mode?: unknown };
  if (
    !Array.isArray(requirement.permissions) ||
    requirement.permissions.some((p) => typeof p !== "string")
  ) {
    return null;
  }
  const mode =
    requirement.mode === "all" ? "all" : requirement.mode === "any" ? "any" : null;
  if (!mode) {
    return null;
  }
  return { permissions: requirement.permissions as string[], mode };
}

function guardNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((guard) => (typeof guard === "function" ? (guard as { name?: string }).name : null))
    .filter((name): name is string => Boolean(name))
    .sort();
}

/**
 * endpointsFromController 从控制器类（及其装饰器元数据）提取端点清单。
 *
 * 与 scanControllers 分离：vitest 的进程内 require 对 TS 源的转换与
 * tsx 运行时不同（装饰器元数据处理差异），全量扫描在 CI 用独立步骤
 * （tsx 运行生成器 + 逐字节比对基线）验证；本函数允许测试直接传入
 * 内联装饰器控制器类来锚定元数据语义。
 */
export function endpointsFromController(
  // 装饰器元数据是 unknown 形状，逐键归一化后使用。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target: any,
  options: {
    name: string;
    classPath: string;
    basePath: string;
    apiRoot: string;
    globalPrefix: string;
  },
): EndpointInfo[] {
  const { name, classPath, basePath, apiRoot, globalPrefix } = options;
  const endpoints: EndpointInfo[] = [];

  // class 级元数据（getAllAndOverride 语义：handler 覆盖 class）。
  const classPublic = Reflect.getMetadata(IS_PUBLIC_KEY, target) === true;
  const classAllowAuthenticated =
    Reflect.getMetadata(ALLOW_AUTHENTICATED_KEY, target) === true;
  const classPermissions = normalizePermissions(
    Reflect.getMetadata(PERMISSIONS_KEY, target),
  );
  const classGuards = guardNames(Reflect.getMetadata(GUARDS_METADATA, target));

  const prototype = target.prototype;
  for (const handlerName of Object.getOwnPropertyNames(prototype)) {
    if (handlerName === "constructor") {
      continue;
    }
    // 用 descriptor 取方法，避免误执行 getter 类属性（如 akshare 的
    // gatewayBaseUrl）——取值会触发 this.env.xxx 在无依赖环境下的崩溃。
    const descriptor = Object.getOwnPropertyDescriptor(prototype, handlerName);
    if (
      !descriptor ||
      typeof descriptor.value !== "function" ||
      // getter/setter 非路由方法，直接跳过。
      typeof descriptor.get === "function" ||
      typeof descriptor.set === "function"
    ) {
      continue;
    }
    const handler = descriptor.value;
    const methodNumber = Reflect.getMetadata(METHOD_METADATA, handler);
    if (methodNumber === undefined) {
      continue; // 非路由方法。
    }
    const method = REQUEST_METHOD_NAMES[methodNumber] ?? `UNKNOWN(${methodNumber})`;
    const handlerPath = String(Reflect.getMetadata(PATH_METADATA, handler) ?? "");
    const headersMetadata = Reflect.getMetadata(HEADERS_METADATA, handler) as
      | { name: string; value: string }[]
      | undefined;
    const headers: Record<string, string> = {};
    if (Array.isArray(headersMetadata)) {
      for (const header of headersMetadata) {
        headers[header.name] = header.value;
      }
    }
    const isSse = Reflect.getMetadata(SSE_METADATA, handler) === true;

    // 路由参数（@Param/@Query/@Body）：装饰器把元数据写到类的
    // ROUTE_ARGS_METADATA[methodName] 上（不是 handler 函数上），键形如
    // "3:0"（paramtype:参数序号），值含 index/data/pipes。
    const routeArgsAll = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      target,
      handlerName,
    ) as Record<string, { index: number; data?: unknown }> | undefined;
    const routeParams: RouteParam[] = [];
    if (routeArgsAll) {
      const paramtypes = Reflect.getMetadata(
        PARAMTYPES_METADATA,
        handler,
      ) as unknown[] | undefined;
      const paramTypeNames = (paramtypes ?? []).map((t) =>
        typeof t === "function" ? (t as { name?: string }).name ?? null : null,
      );
      for (const [key, meta] of Object.entries(routeArgsAll)) {
        const kindNum = Number.parseInt(key.split(":")[0] ?? "", 10);
        const kind: RouteParam["kind"] | null =
          kindNum === 3 ? "body" : kindNum === 4 ? "query" : kindNum === 5 ? "param" : null;
        if (!kind) {
          continue;
        }
        const data = meta.data;
        routeParams.push({
          kind,
          name: typeof data === "string" && data.length > 0 ? data : null,
          typeName: paramTypeNames[meta.index] ?? null,
        });
      }
      routeParams.sort((a, b) => (a.kind + (a.name ?? "") < b.kind + (b.name ?? "") ? -1 : 1));
    }

    const handlerPublic =
      Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true || classPublic;
    const handlerAllowAuthenticated =
      Reflect.getMetadata(ALLOW_AUTHENTICATED_KEY, handler) === true ||
      classAllowAuthenticated;
    const handlerPermissions =
      normalizePermissions(Reflect.getMetadata(PERMISSIONS_KEY, handler)) ??
      classPermissions;
    const handlerGuards = [
      ...new Set([
        ...classGuards,
        ...guardNames(Reflect.getMetadata(GUARDS_METADATA, handler)),
      ]),
    ];

    const path = applyGlobalPrefix(joinPath("", basePath, handlerPath), globalPrefix);

    endpoints.push({
      method: method === "ALL" ? "ALL" : method,
      path,
      controller: name,
      handler: handlerName,
      source: sourceRelative(classPath, apiRoot),
      auth: {
        isPublic: handlerPublic,
        allowAuthenticated: handlerAllowAuthenticated && !handlerPublic,
        permissions: handlerPermissions?.permissions ?? [],
        permissionsMode: handlerPermissions?.mode ?? null,
        guards: handlerGuards,
        platformAdminInHandler: handlerHasPlatformAdminCheck(classPath, handlerName),
      },
      headers,
      isSse,
      pathParams: path
        ? [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? "")
        : [],
      routeParams,
    });
  }

  return endpoints;
}

function sourceRelative(file: string, apiRoot: string): string {
  const rel = relative(apiRoot, file);
  return rel.split(sep).join("/");
}

function joinPath(prefix: string, base: string, handlerPath: string): string {
  const raw = [prefix, base, handlerPath]
    .filter((part) => part && part !== "/")
    .map((part) => part.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  const path = `/${raw.join("/")}`;
  return path.replace(/\/{2,}/g, "/");
}

function handlerHasPlatformAdminCheck(file: string, handlerName: string): boolean {
  // 静态启发式：在 handler 函数体内查找 assertPlatformAdmin/isPlatformAdmin 调用。
  // 误报（同名局部变量）与漏报（间接封装）都可能，因此矩阵只把它标注为
  // "handler 内平台校验（启发式）"，真值仍以人工审计 + 运行时测试为准。
  const content = handlerBodyExtractor(file, handlerName);
  if (!content) {
    return false;
  }
  return /platformAccess\s*\.\s*(assertPlatformAdmin|isPlatformAdmin)\s*\(/.test(content);
}

// 提取 class 方法体的粗糙文本扫描（只用于启发式标注，不参与契约断言）。
// 窗口截断到下一个方法签名（"async xxx(" / "  xxx("），避免相邻 handler 的
// 平台校验调用污染当前 handler 的标注。
function handlerBodyExtractor(file: string, handlerName: string): string | null {
  const content = handlerBodyExtractorCache.get(file);
  if (content === undefined) {
    if (!existsSync(file)) {
      handlerBodyExtractorCache.set(file, null);
      return null;
    }
    handlerBodyExtractorCache.set(file, readFileSync(file, "utf8"));
  }
  if (!content) {
    return null;
  }
  const methodSignature = new RegExp(`\\b(?:async\\s+)?${handlerName}\\s*\\(`, "g");
  let match = methodSignature.exec(content);
  while (match) {
    const bodyStart = content.indexOf("{", match.index);
    // 方法体必须出现在签名后的 200 字符内（签名与 "{" 之间是参数列表）。
    if (bodyStart !== -1 && bodyStart - match.index < 400) {
      let bodyEnd = content.indexOf("\n  }", bodyStart);
      if (bodyEnd === -1) {
        bodyEnd = Math.min(bodyStart + 4000, content.length);
      } else {
        bodyEnd += 4;
      }
      return content.slice(bodyStart, bodyEnd);
    }
    match = methodSignature.exec(content);
  }
  return null;
}

const handlerBodyExtractorCache = new Map<string, string | null>();

// 全局前缀排除规则与 main.ts:62-67 一致：admin/queues* 不带 /api 前缀。
function applyGlobalPrefix(path: string, globalPrefix: string): string {
  const stripped = path.replace(/^\//, "");
  if (stripped === "admin/queues" || stripped.startsWith("admin/queues/")) {
    return `/${stripped}`;
  }
  return `/${globalPrefix.replace(/^\/+|\/+$/g, "")}/${stripped}`.replace(/\/{2,}/g, "/");
}

export function scanControllers(options: {
  apiRoot: string;
  globalPrefix?: string;
}): ScanResult {
  const { apiRoot } = options;
  const globalPrefix = options.globalPrefix ?? "api";
  const errors: string[] = [];
  const endpoints: EndpointInfo[] = [];

  const files = walkControllers(join(apiRoot, "src"));
  const controllers: LoadedController[] = [];
  for (const file of files) {
    try {
      const loaded = loadController(file);
      if (loaded) {
        controllers.push(loaded);
      } else {
        errors.push(`no @Controller export found in ${sourceRelative(file, apiRoot)}`);
      }
    } catch (error) {
      errors.push(
        `failed to load ${sourceRelative(file, apiRoot)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  for (const controller of controllers) {
    endpoints.push(
      ...endpointsFromController(controller.target, {
        name: controller.name,
        classPath: controller.classPath,
        basePath: controller.basePath,
        apiRoot,
        globalPrefix,
      }),
    );
  }

  endpoints.sort((a, b) => {
    if (a.path !== b.path) {
      return a.path < b.path ? -1 : 1;
    }
    if (a.method !== b.method) {
      return a.method < b.method ? -1 : 1;
    }
    return a.handler < b.handler ? -1 : 1;
  });

  return {
    endpoints,
    controllerCount: controllers.length,
    errors,
  };
}
