/**
 * Regression check for the origin the detached window polls.
 *
 * The window cannot guess where its state lives; the Host hands it an origin.
 * The first version passed the browser half's `location.origin` straight
 * through — and inside the desktop shell's sandboxed iframe that value is the
 * literal string `"null"`, so every state poll failed and the window's orphan
 * guard closed it a few seconds after it appeared.
 *
 * `resolveWindowOrigin` is private to `lib/index.js`, so this check extracts
 * the function from the source and evaluates it, the same technique the window
 * smoke test uses for the generated PowerShell.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const hostPath = join(here, "..", "lib", "index.js");

const source = readFileSync(hostPath, "utf8");
const match = source.match(/function resolveWindowOrigin\(request, provided\) \{[\s\S]*?\n\}/);

const failures = [];
const check = (label, condition) => {
	if (!condition) failures.push(label);
};

if (!match) {
	check("resolveWindowOrigin is present in lib/index.js", false);
} else {
	const resolveWindowOrigin = new Function(`${match[0]}\nreturn resolveWindowOrigin;`)();

	// The regression: a sandboxed frame reports "null" and the window must not
	// be pointed at it — the request's own Host header is the reachable truth.
	check(
		'the literal origin "null" falls back to the request host',
		resolveWindowOrigin({ headers: { host: "127.0.0.1:19387" } }, "null") === "http://127.0.0.1:19387",
	);
	check(
		"an empty origin falls back to the request host",
		resolveWindowOrigin({ headers: { host: "127.0.0.1:19387" } }, "") === "http://127.0.0.1:19387",
	);
	check(
		"a real origin is used as given",
		resolveWindowOrigin({ headers: { host: "127.0.0.1:19387" } }, "http://localhost:3080") === "http://localhost:3080",
	);
	check(
		"a trailing slash on the provided origin is trimmed",
		resolveWindowOrigin({ headers: { host: "127.0.0.1:19387" } }, "http://localhost:3080/") === "http://localhost:3080",
	);
	check(
		"https origins are accepted",
		resolveWindowOrigin({}, "https://example.test:8443") === "https://example.test:8443",
	);
	check(
		"neither source yielding an origin refuses the window",
		resolveWindowOrigin({ headers: {} }, "null") === "",
	);
	check(
		"a path-bearing origin is rejected rather than baked into the window",
		resolveWindowOrigin({ headers: { host: "127.0.0.1:19387" } }, "http://localhost:3080/app") === "http://127.0.0.1:19387",
	);
}

if (failures.length > 0) {
	console.error("window-origin check failed:");
	for (const failure of failures) console.error(" - " + failure);
	process.exitCode = 1;
} else {
	console.log("window-origin check passed");
}
