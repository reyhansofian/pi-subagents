import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

/** Classic seccomp BPF. No provider code, credential data or socket authority. */
export function writeCollaborationSocketPolicy(namespaceRoot: string): string {
	if (process.platform !== "linux" || process.arch !== "x64") throw new Error("shared-workspace-unsupported: host socket isolation currently requires Linux x86-64.");
	// Reject compat/x32. New sockets may use only private-namespace IPv4/IPv6.
	// AF_UNIX, AF_VSOCK, netlink, packet and every other family are denied.
	// Only connected AF_UNIX STREAM pairs remain available for libuv stdio.
	// Datagram/seqpacket pairs can retarget a host pathname service and are denied.
	const instructions: [number, number, number, number][] = [
		[0x20, 0, 0, 4],
		[0x15, 1, 0, 0xc000003e],
		[0x06, 0, 0, 0x80000000],
		[0x20, 0, 0, 0],
		[0x45, 0, 1, 0x40000000],
		[0x06, 0, 0, 0x80000000],
		[0x15, 0, 5, 41],
		[0x20, 0, 0, 16],
		[0x15, 1, 0, 2],
		[0x15, 0, 1, 10],
		[0x06, 0, 0, 0x7fff0000],
		[0x06, 0, 0, 0x00050001],
		[0x15, 0, 7, 53],
		[0x20, 0, 0, 16],
		[0x15, 0, 4, 1],
		[0x20, 0, 0, 24],
		[0x54, 0, 0, (~(0x80000 | 0x800)) >>> 0],
		[0x15, 0, 1, 1],
		[0x06, 0, 0, 0x7fff0000],
		[0x06, 0, 0, 0x00050001],
		[0x06, 0, 0, 0x7fff0000],
	];
	const bytes = Buffer.alloc(instructions.length * 8);
	instructions.forEach(([code, jt, jf, value], index) => {
		bytes.writeUInt16LE(code, index * 8); bytes[index * 8 + 2] = jt; bytes[index * 8 + 3] = jf;
		bytes.writeUInt32LE(value, index * 8 + 4);
	});
	const file = path.join(path.dirname(namespaceRoot), "collaboration-socket-policy-" + randomUUID() + ".bpf");
	fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
	return file;
}
