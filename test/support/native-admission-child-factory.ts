import { createDefaultChildSessionFactory } from "../../src/runs/shared/child-session.ts";

export default function () {
	return createDefaultChildSessionFactory({ loadPiCodingAgent: () => import("@earendil-works/pi-coding-agent") });
}
