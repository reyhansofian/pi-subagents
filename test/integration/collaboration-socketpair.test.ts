import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { it } from "node:test";
import { spawnCollaborationSandbox } from "../../src/runs/shared/collaboration-sandbox.ts";
import { collaborationSandboxTools } from "../../src/runs/shared/collaboration-launch.ts";

it("socketpair exceptions cannot repurpose IPC into host pathname or abstract RPC", { timeout: 20000 }, async () => {
	const workspace=fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"collaboration-pair-")));
	const owned=path.join(workspace,"owned"),other=path.join(workspace,"other");
	fs.mkdirSync(owned);fs.mkdirSync(other);
	const protectedFile=path.join(other,"protected");fs.writeFileSync(protectedFile,"ORIGINAL");
	const datagramPath=path.join(other,"datagram.sock"),streamPath=path.join(other,"stream.sock");
	const abstract="collaboration-pair-"+process.pid+"-"+path.basename(workspace);
	const host=spawn("python3",["-u","-c",`import socket,sys,selectors
s=selectors.DefaultSelector()
for address in [sys.argv[1],"\\0"+sys.argv[3]]:
 sock=socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM);sock.bind(address);s.register(sock,selectors.EVENT_READ)
print("READY",flush=True)
while True:
 for key,_ in s.select():
  data=key.fileobj.recv(1024)
  if data:open(sys.argv[2],"w").write("RPC_CHANGED")
`,datagramPath,protectedFile,abstract],{stdio:["ignore","pipe","pipe"]});
	let ready="";host.stdout.on("data",chunk=>{ready+=chunk});
	const deadline=Date.now()+3000;while(!ready.includes("READY")){if(Date.now()>deadline)throw Error("Synthetic service not ready");await new Promise(resolve=>setTimeout(resolve,5))}
	const server=net.createServer(socket=>socket.on("data",()=>{fs.writeFileSync(protectedFile,"STREAM_RPC_CHANGED");socket.end()}));
	server.listen(streamPath);await once(server,"listening");
	const program=`import socket,json,ctypes
rows={}
for family in [0,1,16,17,31,40]:
 try:s=socket.socket(family,socket.SOCK_STREAM);s.close();rows["family-"+str(family)]="CREATED"
 except OSError as e:rows["family-"+str(family)]=e.errno
targets=[${JSON.stringify(datagramPath)},"\\0"+${JSON.stringify(abstract)}]
for kind in [socket.SOCK_DGRAM,socket.SOCK_SEQPACKET]:
 for target in targets:
  name="pair-"+str(kind)+"-"+("abstract" if target.startswith("\\0") else "pathname")
  try:
   a,b=socket.socketpair(socket.AF_UNIX,kind)
   try:a.sendto(b"WRITE",target);rows[name]="SENT"
   except OSError as e:rows[name]=e.errno
   a.close();b.close()
  except OSError as e:rows[name]=e.errno
for operation in ["connect","peer-close","shutdown","sendto","sendmsg","unspec"]:
 a,b=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM)
 try:
  if operation=="peer-close":b.close()
  if operation=="shutdown":a.shutdown(socket.SHUT_RDWR)
  if operation=="unspec":
   libc=ctypes.CDLL(None,use_errno=True)
   class Address(ctypes.Structure):_fields_=[("family",ctypes.c_ushort)]
   address=Address(socket.AF_UNSPEC);result=libc.connect(a.fileno(),ctypes.byref(address),ctypes.sizeof(address))
   rows["unspec-result"]=[result,ctypes.get_errno()]
  if operation=="sendto":a.sendto(b"WRITE",${JSON.stringify(streamPath)})
  elif operation=="sendmsg":a.sendmsg([b"WRITE"],[],0,${JSON.stringify(streamPath)})
  else:a.connect(${JSON.stringify(streamPath)});a.sendall(b"WRITE")
  rows[operation]="SENT"
 except OSError as e:rows[operation]=e.errno
 a.close();b.close()
print(json.dumps(rows),flush=True)
`;
	const code=`import {spawnSync} from "node:child_process";const r=spawnSync("python3",["-c",${JSON.stringify(program)}],{encoding:"utf8"});if(r.status!==0)throw Error(r.stderr);process.stdout.write(r.stdout);`;
	const child=spawnCollaborationSandbox({workspace,namespaceRoot:fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(),"collaboration-pair-ns-"))),hostSocketIsolation:true,readPaths:[],writePaths:[owned],runtimePaths:["/nix/store","/proc"],command:fs.realpathSync.native(process.execPath),args:["--input-type=module","-e",code],env:{PATH:process.env.PATH??"",HOME:owned,TMPDIR:owned},tools:collaborationSandboxTools()});
	let stdout="",stderr="";child.process.stdout.on("data",chunk=>{stdout+=chunk});child.process.stderr.on("data",chunk=>{stderr+=chunk});
	try{
		const end=await child.terminal;assert.equal(end.code,0,stderr);
		const rows=JSON.parse(stdout);
		console.log("SOCKETPAIR_BOUNDARY "+JSON.stringify({rows,protectedContents:fs.readFileSync(protectedFile,"utf8")}));
		for(const [key,value] of Object.entries(rows))if(key.startsWith("pair-")||key.startsWith("family-"))assert.equal(value,1,"Only private IP sockets and connected STREAM pairs are permitted.");
		assert.equal(rows["unspec-result"][0],-1,"AF_UNSPEC must not disconnect a stream pair for reconnection.");
		assert.equal(fs.readFileSync(protectedFile,"utf8"),"ORIGINAL","Host RPC must remain inaccessible.");
	}finally{child.stop();host.kill("SIGTERM");server.close();await once(server,"close")}
});
