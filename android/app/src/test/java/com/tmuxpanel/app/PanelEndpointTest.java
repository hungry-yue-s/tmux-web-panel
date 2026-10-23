package com.tmuxpanel.app;

import org.junit.Test;
import static org.junit.Assert.*;

public class PanelEndpointTest {
    @Test public void normalizesConnectionAndLoginAddresses() {
        assertEquals("https://panel.example/", PanelEndpoint.parse(" panel.example ").url());
        assertEquals("http://192.168.1.5:7681/", PanelEndpoint.parse("http://192.168.1.5:7681/index.html").url());
        assertEquals("https://panel.example/work/", PanelEndpoint.parse("https://panel.example/work/login.html").url());
        assertEquals("https://[::1]:7681/", PanelEndpoint.parse("https://[::1]:7681").url());
    }

    @Test public void rejectsNonServerAddressesAndCredentials() {
        String[] invalid = {"", "file:///tmp/panel", "javascript:alert(1)", "https://user:secret@example.com",
            "https://example.com?token=secret", "https://example.com/#/settings", "https://example.com:0",
            "https://example.com:99999", "https://exam ple.com", "https://example.com/\npath"};
        for (String input : invalid) {
            try { PanelEndpoint.parse(input); fail("Accepted invalid address: " + input); }
            catch (IllegalArgumentException expected) { /* must not persist credentials or tokens */ }
        }
    }

    @Test public void confinesNativeFeaturesToTheConfiguredOriginAndBasePath() {
        PanelEndpoint panel = PanelEndpoint.parse("https://panel.example/work/");
        assertTrue(panel.contains("https://panel.example:443/work/index.html#/settings"));
        assertTrue(panel.contains("HTTPS://PANEL.EXAMPLE/work/login.html"));
        assertFalse(panel.contains("https://panel.example.evil.test/work/"));
        assertFalse(panel.contains("https://evil@panel.example/work/"));
        assertFalse(panel.contains("http://panel.example/work/"));
        assertFalse(panel.contains("https://panel.example:7681/work/"));
        assertFalse(panel.contains("https://panel.example/workshop/"));
        assertFalse(panel.contains("https://panel.example/work/../other/"));
        assertTrue(PanelEndpoint.parse("https://panel.example").contains("https://panel.example"));
        assertFalse(panel.contains("blob:https://panel.example/123"));
        assertFalse(panel.contains(null));
    }

    @Test public void resolvesBootstrapHandoffsWithoutPersistingTheirTokens() {
        PanelEndpoint entry = PanelEndpoint.parse("https://example.github.io/panel/");
        assertEquals("https://192.168.1.10:7681/", entry.bootstrapTarget(entry.url(),
            "https://192.168.1.10:7681/login.html?relay=1", false).url());
        assertEquals("https://192.168.1.11:7681/", entry.bootstrapTarget(entry.url(),
            "https://192.168.1.11:7681/#handoff=not-a-real-token", false).url());
        assertNull(entry.bootstrapTarget(entry.url(), "http://192.168.1.10:7681/", false));
        assertNull(entry.bootstrapTarget(entry.url(), "https://elsewhere.example/", true));
        assertNull(entry.bootstrapTarget("https://untrusted.example/", "https://192.168.1.10/", false));
        assertNull(entry.bootstrapTarget(entry.url(), "https://user:password@192.168.1.10/", false));
        assertNull(entry.bootstrapTarget(entry.url(), "javascript:alert(1)", false));
    }
}
