import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	createService,
	deleteService,
	getService,
	listServices,
} from "@/controllers/service.controller";

const manifestService = {
	listServices: vi.fn(),
	getService: vi.fn(),
	createService: vi.fn(),
	deleteService: vi.fn(),
};

type MockResponse = {
	status: ReturnType<typeof vi.fn>;
	json: ReturnType<typeof vi.fn>;
	send: ReturnType<typeof vi.fn>;
};

const makeRes = () => {
	const res = {} as MockResponse;
	res.status = vi.fn().mockReturnValue(res);
	res.json = vi.fn().mockReturnValue(res);
	res.send = vi.fn().mockReturnValue(res);
	return res;
};

const makeReq = (overrides: Record<string, unknown> = {}) =>
	({
		app: { locals: { manifestService } },
		params: {},
		...overrides,
	}) as unknown as Request;

describe("service.controller", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("lists services", async () => {
		const res = makeRes();
		const req = makeReq();
		manifestService.listServices.mockResolvedValue([
			{ name: "service-a", hash: "hash-a", tools: [] },
			{ name: "service-b", hash: "hash-b", tools: [] },
		]);

		await listServices(req, res as unknown as Response);

		expect(manifestService.listServices).toHaveBeenCalledOnce();
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({
			services: [
				{ name: "service-a", hash: "hash-a", tools: [] },
				{ name: "service-b", hash: "hash-b", tools: [] },
			],
		});
	});

	it("gets a single service", async () => {
		const res = makeRes();
		const req = makeReq({ params: { serviceName: "svc-1" } });
		manifestService.getService.mockResolvedValue({
			name: "svc-1",
			hash: "hash-1",
			metadata: { serverUrl: "http://127.0.0.1:9999" },
			tools: [
				{
					name: "echo",
					metadata: {},
					inputSchema: { type: "object" },
					outputSchema: { type: "string" },
				},
			],
		});

		await getService(req, res as unknown as Response);

		expect(manifestService.getService).toHaveBeenCalledWith("svc-1");
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({
			name: "svc-1",
			hash: "hash-1",
			metadata: { serverUrl: "http://127.0.0.1:9999" },
			tools: [
				{
					name: "echo",
					metadata: {},
					inputSchema: { type: "object" },
					outputSchema: { type: "string" },
				},
			],
		});
	});

	it("creates a service", async () => {
		const res = makeRes();
		const req = makeReq({
			params: { serviceName: "svc-1" },
			body: {
				manifest: JSON.stringify({ name: "svc-1", metadata: {}, tools: [] }),
			},
		});

		await createService(req, res as unknown as Response);

		expect(manifestService.createService).toHaveBeenCalledWith(
			"svc-1",
			JSON.stringify({ name: "svc-1", metadata: {}, tools: [] }),
		);
		expect(res.status).toHaveBeenCalledWith(201);
		expect(res.json).toHaveBeenCalledWith({ name: "svc-1" });
	});

	it("deletes a service", async () => {
		const res = makeRes();
		const req = makeReq({ params: { serviceName: "svc-1" } });
		manifestService.deleteService.mockResolvedValue(undefined);

		await deleteService(req, res as unknown as Response);

		expect(manifestService.deleteService).toHaveBeenCalledWith("svc-1");
		expect(res.status).toHaveBeenCalledWith(204);
		expect(res.send).toHaveBeenCalledWith();
	});
});
