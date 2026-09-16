import type {
  AuthProvider,
  BaseRecord,
  DataProvider,
  HttpError,
  GetOneParams,
  CreateParams,
  UpdateParams,
  DeleteOneParams,
  CustomParams,
} from "@refinedev/core";

export interface Identity {
  id: string;
  username: string;
  hf_username?: string | null;
}
interface Session {
  user: Identity | null;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function request<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("X-Track-Request", "1");
  if (typeof options.body === "string" && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers,
  });
  const text = await response.text();
  options.signal?.throwIfAborted();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const detail = record(body) ? body.detail : undefined;
    const message =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail
              .map((item: unknown) =>
                record(item)
                  ? `${Array.isArray(item.loc) ? item.loc.join(".") : "Request"}: ${String(item.msg)}`
                  : String(item),
              )
              .join("; ")
          : `Request failed (${response.status})`;
    throw Object.assign(new Error(message), {
      statusCode: response.status,
    }) satisfies HttpError;
  }
  // Callers supply the response contract of the same-version FastAPI endpoint.
  return body as T;
}

function endpoint(resource: string, id?: string | number) {
  return `/api/${resource}${id === undefined ? "" : "/" + encodeURIComponent(id)}`;
}

export const dataProvider: DataProvider = {
  getApiUrl: () => "/api",
  getList: async <TData extends BaseRecord>({
    resource,
    meta,
  }: Parameters<DataProvider["getList"]>[0]) => {
    const data = await request<TData[] | { items: TData[]; total: number }>(
      meta?.url || endpoint(resource),
      { signal: meta?.signal },
    );
    return Array.isArray(data)
      ? { data, total: data.length }
      : { data: data.items, total: data.total };
  },
  getOne: async <TData extends BaseRecord>({
    resource,
    id,
    meta,
  }: GetOneParams) => ({
    data: await request<TData>(meta?.url || endpoint(resource, id), {
      signal: meta?.signal,
    }),
  }),
  create: async <TData extends BaseRecord, TVariables>({
    resource,
    variables,
    meta,
  }: CreateParams<TVariables>) => ({
    data: await request<TData>(meta?.url || endpoint(resource), {
      method: "POST",
      body: JSON.stringify(variables),
    }),
  }),
  update: async <TData extends BaseRecord, TVariables>({
    resource,
    id,
    variables,
    meta,
  }: UpdateParams<TVariables>) => ({
    data: await request<TData>(meta?.url || endpoint(resource, id), {
      method: "PATCH",
      body: JSON.stringify(variables),
    }),
  }),
  deleteOne: async <TData extends BaseRecord, TVariables>({
    resource,
    id,
    meta,
  }: DeleteOneParams<TVariables>) => ({
    data: await request<TData>(meta?.url || endpoint(resource, id), {
      method: "DELETE",
    }),
  }),
  custom: async <TData extends BaseRecord, TQuery, TPayload>({
    url,
    method,
    payload,
    query,
    headers,
    meta,
  }: CustomParams<TQuery, TPayload>) => {
    const target = new URL(url, window.location.origin);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value))
        value.forEach((item) => target.searchParams.append(key, String(item)));
      else target.searchParams.set(key, String(value));
    }
    return {
      data: await request<TData>(target.pathname + target.search, {
        method: method.toUpperCase(),
        headers,
        signal: meta?.signal,
        ...(payload !== undefined
          ? {
              body:
                payload instanceof FormData ? payload : JSON.stringify(payload),
            }
          : {}),
      }),
    };
  },
};

export const authProvider: AuthProvider = {
  login: async () => {
    const result = await request<{ url: string }>(
      "/api/auth/huggingface/start",
      { method: "POST", body: JSON.stringify({ link: false }) },
    );
    window.location.assign(result.url);
    return { success: true };
  },
  logout: async () => {
    await request("/api/auth/logout", { method: "POST", body: "{}" });
    return { success: true, redirectTo: "/login" };
  },
  check: async () => {
    const { user } = await request<Session>("/api/auth/me");
    return user
      ? { authenticated: true }
      : { authenticated: false, redirectTo: "/login" };
  },
  getIdentity: async () => (await request<Session>("/api/auth/me")).user,
  onError: async (error) => ({ error }),
};
