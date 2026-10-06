/** One-shot state server for the WPF window smoke test. */
import { createServer } from "node:http";

const state = {
	ok: true,
	open: true,
	rows: [
		{ id: "smoke-1", title: "冒烟测试会话", state: "running", blank: false, updatedAt: 1 },
		{ id: "smoke-2", title: "等待审批的会话", state: "attention", blank: false, updatedAt: 2 },
		{ id: "smoke-3", title: "已完成的会话", state: "done", blank: false, updatedAt: 3 },
		{ id: "smoke-4", title: "空闲的会话", state: "idle", blank: false, updatedAt: 4 },
	],
	runningCount: 2,
	totalCount: 4,
	showAll: true,
};

const server = createServer((request, response) => {
	if (request.method === "GET" && request.url.startsWith("/dsh-session-monitor/state")) {
		response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
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
