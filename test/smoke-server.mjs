/**
 * One-shot state server for the WPF window smoke test.
 *
 * It mirrors the real payload, including the settings the window reads beyond
 * the row list: `showAll`/`notifyOn` for the header buttons, `opacity` for the
 * background alpha, `totalCount` for the hint's counter, and the per-row
 * hierarchy facts (`child`, `childCount`, `collapsed`). The charset is
 * explicit: PowerShell 5.1 decodes a charset-less body as Latin-1, which is
 * what turned Chinese session titles into mojibake.
 */
import { createServer } from "node:http";

const state = {
	ok: true,
	open: true,
	rows: [
		{ id: "smoke-1", title: "冒烟测试会话", state: "running", blank: false, updatedAt: 1, child: false, childCount: 2, collapsed: false },
		{ id: "smoke-1-a", title: "子 agent：检索代码", state: "running", blank: false, updatedAt: 2, child: true, childCount: 0, collapsed: false },
		{ id: "smoke-1-b", title: "子 agent：写测试", state: "attention", blank: false, updatedAt: 3, child: true, childCount: 0, collapsed: false },
		{ id: "smoke-2", title: "等待审批的会话", state: "attention", blank: false, updatedAt: 4, child: false, childCount: 0, collapsed: false },
		{ id: "smoke-3", title: "已完成的会话", state: "done", blank: false, updatedAt: 5, child: false, childCount: 1, collapsed: true },
		{ id: "smoke-4", title: "空闲的会话", state: "idle", blank: false, updatedAt: 6, child: false, childCount: 0, collapsed: false },
	],
	runningCount: 3,
	totalCount: 12,
	showAll: false,
	notifyOn: true,
	// Deliberately mid-range, so the smoke window proves the alpha is applied
	// rather than merely accepted.
	opacity: 0.55,
};

const server = createServer((request, response) => {
	if (request.method === "GET" && request.url.startsWith("/dsh-session-monitor/state")) {
		response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		response.end(JSON.stringify(state));
		return;
	}
	response.writeHead(404);
	response.end("not found");
});

server.listen(39999, "127.0.0.1", () => {
	console.log("smoke state server on http://127.0.0.1:39999");
});
setTimeout(() => process.exit(0), 20000).unref();
