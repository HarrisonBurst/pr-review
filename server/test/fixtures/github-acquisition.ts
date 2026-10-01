import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkoutEnvironment } from "../../execution/adapters.js";
import { runCommand } from "../../util.js";

export async function githubAcquisitionFixture() {
  const root = await mkdtemp(
    path.join(tmpdir(), "pr-review-synthetic-github-"),
  );
  const bin = path.join(root, "bin");
  const repository = path.join(root, "fixture/repository.git");
  const source = path.join(root, "source");
  await Promise.all(
    [bin, repository, source].map((dir) => mkdir(dir, { recursive: true })),
  );
  const calls = path.join(root, "calls");
  const canary = "synthetic-github-credential-canary";
  const env = checkoutEnvironment({
    HOME: root,
    PATH: `${bin}:/usr/bin:/bin`,
    FIXTURE_CALLS: calls,
    FIXTURE_CANARY: canary,
    GIT_AUTHOR_NAME: "Synthetic fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  });
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runCommand("/usr/bin/git", args, {
      cwd,
      env,
      timeoutMs: 10000,
    });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  await git(repository, "init", "--initial-branch=main");
  await writeFile(path.join(repository, "code.txt"), "common\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "common");
  const common = await git(repository, "rev-parse", "HEAD");
  await git(repository, "update-ref", "refs/heads/snapshot", common);
  await writeFile(path.join(repository, "base.txt"), "recorded base\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "base");
  const baseSha = await git(repository, "rev-parse", "HEAD");
  await git(repository, "checkout", "-b", "topic", common);
  await writeFile(path.join(repository, "code.txt"), "recorded head\n");
  await git(repository, "commit", "-am", "head");
  const headSha = await git(repository, "rev-parse", "HEAD");
  await git(repository, "update-ref", "refs/pull/7/head", headSha);
  const cert = path.join(root, "cert.pem");
  const key = path.join(root, "key.pem");
  const certificate = await runCommand(
    "/usr/bin/openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=github.com",
      "-addext",
      "subjectAltName=DNS:github.com",
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { env, timeoutMs: 10000 },
  );
  assert.equal(certificate.code, 0, "synthetic certificate creation failed");
  const requests: { path: string; authorized: boolean }[] = [];
  const transport: { redirect?: string } = {};
  const sockets = new Set<net.Socket>();
  const server = https.createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (request, response) => {
      const authorized =
        request.headers.authorization ===
        `Basic ${Buffer.from(`fixture:${canary}`).toString("base64")}`;
      requests.push({ path: request.url!, authorized });
      if (transport.redirect) {
        response.writeHead(302, { location: transport.redirect });
        response.end();
        return;
      }
      if (!authorized) {
        response.writeHead(401, {
          "www-authenticate": 'Basic realm="synthetic fixture"',
        });
        response.end();
        return;
      }
      const url = new URL(request.url!, "https://github.com");
      const backend = spawn("/usr/bin/git", ["http-backend"], {
        env: {
          ...env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method!,
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          REMOTE_USER: "fixture",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      request.pipe(backend.stdin);
      const chunks: Buffer[] = [];
      backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      backend.stderr.resume();
      backend.on("close", () => {
        const result = Buffer.concat(chunks);
        const separator = result.indexOf("\r\n\r\n");
        if (separator < 0) {
          response.writeHead(500);
          response.end();
          return;
        }
        const headers = result.subarray(0, separator).toString().split("\r\n");
        let status = 200;
        for (const header of headers) {
          const split = header.indexOf(":");
          const name = header.slice(0, split);
          const value = header.slice(split + 1).trim();
          if (name.toLowerCase() === "status")
            status = Number(value.split(" ")[0]);
          else response.setHeader(name, value);
        }
        response.writeHead(status);
        response.end(result.subarray(separator + 4));
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const proxy = http.createServer((_request, response) => {
    response.writeHead(403);
    response.end();
  });
  proxy.on("connect", (request, socket, head) => {
    if (request.url !== "github.com:443") {
      socket.destroy();
      return;
    }
    const upstream = net.connect(port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    sockets.add(upstream);
    upstream.on("close", () => sockets.delete(upstream));
  });
  for (const service of [server, proxy])
    service.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  env.https_proxy = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
  env.no_proxy = "";
  env.GIT_SSL_CAINFO = cert;
  await writeFile(calls, "");
  const script = path.join(bin, "gh");
  await writeFile(
    script,
    `#!${process.execPath}\nconst fs=require('node:fs'); const {spawnSync}=require('node:child_process'); const args=process.argv.slice(2); if(args[0]==='auth'&&args[1]==='git-credential'){const input=fs.readFileSync(0,'utf8');fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({kind:'credential',operation:args[2],fields:Object.fromEntries(input.trim().split('\\n').map(line=>line.split('=')).filter(([key])=>['protocol','host','path'].includes(key)))})+'\\n'); if(args[2]!=='get')process.exit(0); if(process.env.FIXTURE_CREDENTIAL==='unavailable')process.exit(1); process.stderr.write(process.env.FIXTURE_CANARY); process.stdout.write('username=fixture\\npassword='+ (process.env.FIXTURE_CREDENTIAL==='denied'?'denied':process.env.FIXTURE_CANARY)+'\\n'); process.exit(0);} if(args.join(' ').startsWith('repo clone fixture/repository ')){const result=spawnSync('/usr/bin/git',['-c','credential.helper=','-c','credential.helper=!gh auth git-credential 2>/dev/null','clone','--single-branch','--branch','snapshot','--no-tags','--no-checkout','https://github.com/fixture/repository.git',args[3]],{env:{...process.env,FIXTURE_CREDENTIAL:''},stdio:'inherit'}); if(result.status===0){fs.appendFileSync(process.env.FIXTURE_CALLS,JSON.stringify({kind:'clone'})+'\\n'); if(process.env.FIXTURE_CONFIG){fs.appendFileSync(args[3]+'/.git/config',process.env.FIXTURE_CONFIG);}if(process.env.FIXTURE_ORIGIN){spawnSync('/usr/bin/git',['config','remote.origin.url',process.env.FIXTURE_ORIGIN],{cwd:args[3],stdio:'inherit'});}}process.exit(result.status??1);} process.exit(1);\n`,
  );
  await chmod(script, 0o700);
  await writeFile(
    path.join(root, ".gitconfig"),
    '[credential "https://github.com"]\n helper = !gh auth git-credential 2>/dev/null\n',
  );
  return {
    root,
    source,
    checkout: path.join(source, "checkout"),
    env,
    git,
    requests,
    transport,
    canary,
    identity: { repository: "fixture/repository", number: 7, baseSha, headSha },
    calls: async () =>
      (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              kind: string;
              operation?: string;
              fields?: Record<string, string>;
            },
        ),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [server, proxy].map(
          (service) =>
            new Promise<void>((resolve) => service.close(() => resolve())),
        ),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}
