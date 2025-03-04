import { connect } from "cloudflare:sockets";

export default {
  async fetch(request, env): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response(null, { status: 426 });
    } else {
      const { 0: client, 1: server } = new WebSocketPair();
      handleVLESS(request, env.UUID, env.PROXY_IP, server);
      return new Response(null, { status: 101, webSocket: client });
    }
  },
} satisfies ExportedHandler<Env>;

type Ref<T> = { value: T };

async function handleVLESS(
  request: Request,
  userID: string,
  proxyIP: string,
  server: WebSocket
) {
  const readableStream = handleWebSocket(request, server);
  const ref: Ref<Socket> = { value: null };
  for await (const chunk0 of readableStream) {
    if (!ref.value) {
      const { version, isUDP, port, hostname, byteOffset } = handleHeader(
        chunk0,
        userID
      );
      if (isUDP && port !== 53) {
        throw new Error("only DNS for UDP");
      }
      const header = new Uint8Array([version[0], 0]);
      const chunk1 = chunk0.slice(byteOffset);
      const hosts = isUDP
        ? [{ hostname: "8.8.4.4", port: 53 }]
        : [{ hostname, port }];
      hosts.push({ hostname: proxyIP, port: 443 });
      handleSocket(server, header, chunk1, hosts, ref);
    } else {
      writeSocket(ref.value, chunk0);
    }
  }
}

function handleWebSocket(request: Request, webSocket: WebSocket) {
  webSocket.accept();
  return new ReadableStream<ArrayBuffer>({
    start(controller) {
      const earlyData = base64ToArrayBuffer(
        request.headers.get("Sec-WebSocket-Protocol")
      );
      earlyData && controller.enqueue(earlyData);
      webSocket.addEventListener("message", (event) => {
        controller.enqueue(event.data as ArrayBuffer);
      });
    },
  });
}

function handleHeader(buffer: ArrayBuffer, userID: string) {
  let byteOffset = 0;
  const [version] = new Uint8Array(buffer, byteOffset, 1);
  byteOffset += 1;
  const uuid = new Uint8Array(buffer, byteOffset, 16).reduce(
    (previousValue, currentValue, currentIndex) =>
      previousValue +
      ([4, 6, 8, 10].indexOf(currentIndex) !== -1 ? "-" : "") +
      currentValue.toString(16).padStart(2, "0"),
    ""
  );
  byteOffset += 16;
  if (uuid !== userID) {
    throw new Error(`unknow UUID: ${uuid}`);
  }
  const [addonsLen] = new Uint8Array(buffer, byteOffset, 1);
  byteOffset += 1 + addonsLen;
  const [command] = new Uint8Array(buffer, byteOffset, 1);
  byteOffset += 1;
  let isUDP = false;
  if (command === 1) {
  } else if (command === 2) {
    isUDP = true;
  } else {
    throw new Error(`unknow command ${command}`);
  }
  const port = new DataView(buffer, byteOffset, 2).getUint16(0);
  byteOffset += 2;
  const [af] = new Uint8Array(buffer, byteOffset, 1);
  byteOffset += 1;
  let addressLen: number;
  let hostname: string;
  if (af === 1) {
    // IPv4
    addressLen = 4;
    hostname = new Uint8Array(buffer, byteOffset, addressLen).join(".");
  } else if (af === 2) {
    // FQDN
    [addressLen] = new Uint8Array(buffer, byteOffset, 1);
    byteOffset += 1;
    hostname = new TextDecoder().decode(
      buffer.slice(byteOffset, byteOffset + addressLen)
    );
  } else if (af === 3) {
    // IPv6
    addressLen = 16;
    const view = new DataView(
      buffer.slice(byteOffset, byteOffset + addressLen)
    );
    const ipv6 = [];
    for (let i = 0; i < 8; i += 1) {
      ipv6.push(view.getUint16(i * 2).toString(16));
    }
    hostname = ipv6.join(":");
  } else {
    throw new Error(`unknow address family: ${af}`);
  }
  byteOffset += addressLen;
  return {
    version,
    isUDP,
    port,
    hostname,
    byteOffset,
  };
}

async function handleSocket(
  server: WebSocket,
  header: Uint8Array,
  chunk: ArrayBuffer,
  hosts: { hostname: string; port: number }[],
  ref: Ref<Socket>
) {
  ref.value = connect(hosts[0]);
  await writeSocket(ref.value, chunk);
  let sent = false;
  let received = false;
  await ref.value.readable.pipeTo(
    new WritableStream({
      async write(chunk) {
        received = true;
        if (!sent) {
          server.send(await new Blob([header, chunk]).arrayBuffer());
          sent = true;
        } else {
          server.send(chunk);
        }
      },
    })
  );
  if (!received && hosts.length > 1) {
    handleSocket(server, header, chunk, hosts.slice(1), ref);
  }
}

async function writeSocket(socket: Socket, chunk: ArrayBuffer) {
  const writer = socket.writable.getWriter();
  await writer.write(chunk);
  writer.releaseLock();
}

function base64ToArrayBuffer(base64: string) {
  if (!base64) {
    return null;
  }
  return Uint8Array.from(
    atob(base64.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0)
  ).buffer;
}
