#!/usr/bin/env python3
"""Send one JSON request on stdin to a host-local Durable worker socket.

Run through any authorized remote command transport. Disconnecting this client
does not cancel admitted work. Retry submit with its original requestId.
"""
import http.client
import json
import socket
import sys


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: durable-client.py <worker socket>")
    value = json.load(sys.stdin)
    connection = http.client.HTTPConnection("localhost", timeout=40)
    connection.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.sock.settimeout(40)
    connection.sock.connect(sys.argv[1])
    try:
        connection.request("POST", "/v1", json.dumps(value), {"Content-Type": "application/json"})
        response = connection.getresponse()
        body = response.read(16 * 1024 * 1024 + 1)
        if len(body) > 16 * 1024 * 1024:
            raise RuntimeError("Worker response exceeds client limit")
        print(body.decode("utf-8"))
        return 0 if response.status == 200 else 1
    finally:
        connection.close()


if __name__ == "__main__":
    raise SystemExit(main())
