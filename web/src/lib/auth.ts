/** 站内相对路径校验，防止 ?next= 被用来做开放重定向。 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return "/";
    if (url.pathname === "/login" || url.pathname.startsWith("/login/")) {
      return "/";
    }
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

/** 把当前受保护地址编码进 /login?next=。 */
export function loginUrlFor(
  pathname: string,
  search: string,
  hash: string,
): string {
  if (pathname === "/" && !search && !hash) return "/login";
  return `/login?next=${encodeURIComponent(`${pathname}${search}${hash}`)}`;
}
