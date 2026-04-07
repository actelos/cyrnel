import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	deleteService,
	getService,
	listServices,
} from "@/controllers/service.controller";

const manifestService = {
	listServices: vi.fn(),
	getService: vi.fn(),
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
			{ name: "service-a" },
			{ name: "service-b" },
		]);

		await listServices(req, res as unknown as Response);

		expect(manifestService.listServices).toHaveBeenCalledOnce();
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({
			services: [{ name: "service-a" }, { name: "service-b" }],
		});
	});

	it("gets a single service", async () => {
		const res = makeRes();
		const req = makeReq({ params: { serviceId: "svc-1" } });
		manifestService.getService.mockResolvedValue({ name: "svc-1" });

		await getService(req, res as unknown as Response);

		expect(manifestService.getService).toHaveBeenCalledWith("svc-1");
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({ name: "svc-1" });
	});

	it("deletes a service", async () => {
		const res = makeRes();
		const req = makeReq({ params: { serviceId: "svc-1" } });
		manifestService.deleteService.mockResolvedValue(undefined);

		await deleteService(req, res as unknown as Response);

		expect(manifestService.deleteService).toHaveBeenCalledWith("svc-1");
		expect(res.status).toHaveBeenCalledWith(204);
		expect(res.send).toHaveBeenCalledWith();
	});
});
