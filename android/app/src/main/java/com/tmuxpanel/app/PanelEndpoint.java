package com.tmuxpanel.app;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** The only native origin is the panel the user explicitly connected to. */
public final class PanelEndpoint {
    public final URI uri;

    private PanelEndpoint(URI uri) { this.uri = uri; }

    public static PanelEndpoint parse(String input) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty() || value.matches(".*[\\p{Cntrl}\\s].*")) throw new IllegalArgumentException("请输入有效的服务器地址");
        if (!value.contains("://")) value = "https://" + value;
        try {
            URI parsed = new URI(value).normalize();
            String scheme = parsed.getScheme().toLowerCase(Locale.ROOT);
            if (!(scheme.equals("https") || scheme.equals("http")) || parsed.getHost() == null
                    || parsed.getRawUserInfo() != null || parsed.getPort() == 0 || parsed.getPort() > 65535
                    || parsed.getRawQuery() != null || parsed.getRawFragment() != null) {
                throw new IllegalArgumentException("使用 http:// 或 https:// 地址，不包含账号、查询参数或页面片段");
            }
            String path = parsed.getRawPath();
            if (path == null || path.isEmpty()) path = "/";
            if (path.endsWith("/index.html") || path.endsWith("/login.html")) path = path.substring(0, path.lastIndexOf('/') + 1);
            if (!path.endsWith("/")) path += "/";
            return new PanelEndpoint(new URI(scheme + "://" + parsed.getRawAuthority().toLowerCase(Locale.ROOT) + path));
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("服务器地址格式不正确", e);
        }
    }

    public String origin() { return uri.getScheme() + "://" + uri.getRawAuthority(); }
    public String url() { return uri.toASCIIString(); }

    /** Only the configured entry page may automatically resolve a new HTTPS origin. */
    public PanelEndpoint bootstrapTarget(String currentUrl, String nextUrl, boolean userGesture) {
        if (userGesture || !contains(currentUrl) || sameOrigin(nextUrl)) return null;
        try {
            URI next = new URI(nextUrl);
            if (!"https".equalsIgnoreCase(next.getScheme())) return null;
            return parse(next.getScheme() + "://" + next.getRawAuthority()
                    + (next.getRawPath() == null ? "/" : next.getRawPath()));
        } catch (IllegalArgumentException | URISyntaxException e) { return null; }
    }

    public boolean sameOrigin(String url) {
        try {
            URI other = new URI(url);
            return other.getRawUserInfo() == null && uri.getScheme().equalsIgnoreCase(other.getScheme())
                    && uri.getHost().equalsIgnoreCase(other.getHost()) && port(uri) == port(other);
        } catch (Exception e) { return false; }
    }

    public boolean contains(String url) {
        if (!sameOrigin(url)) return false;
        try {
            String path = new URI(url).normalize().getRawPath();
            return (path == null || path.isEmpty() ? "/" : path).startsWith(uri.getRawPath());
        }
        catch (Exception e) { return false; }
    }

    private static int port(URI uri) { return uri.getPort() < 0 ? ("https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80) : uri.getPort(); }
}
