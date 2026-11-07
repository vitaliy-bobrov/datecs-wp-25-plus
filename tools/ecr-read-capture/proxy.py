#!/usr/bin/env python3
"""Host-only ECR Tool read capture proxy.

Creates a PTY for Wine COM1, connects to the real cashier serial device,
and logs every byte in both directions as JSONL. The proxy never generates
device traffic; it only forwards what the ECR Tool sends.
"""
from __future__ import annotations

import argparse
import json
import os
import pty
import select
import signal
import sys
import termios
import time
import tty
from pathlib import Path

try:
    import serial
except ImportError:
    sys.exit("Install pyserial on the host first: python3 -m pip install pyserial")


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int(time.time() * 1000) % 1000:03d}Z"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", required=True, help="cashier serial device, e.g. /dev/cu.usbmodem1234")
    parser.add_argument("--baud", type=int, default=9600)
    parser.add_argument("--log", default="ecr-read-capture.jsonl")
    parser.add_argument("--wine-prefix", default=str(Path.home() / ".wine"),
                        help="Wine prefix whose dosdevices/com1 should point at the PTY")
    args = parser.parse_args()

    cashier = serial.Serial(args.device, args.baud, timeout=0, write_timeout=1)
    master, slave = pty.openpty()
    tty.setraw(slave)
    pty_name = os.ttyname(slave)

    wine_com1 = Path(args.wine_prefix) / "dosdevices" / "com1"
    wine_com1.parent.mkdir(parents=True, exist_ok=True)
    if wine_com1.is_symlink() or wine_com1.exists():
        wine_com1.unlink()
    wine_com1.symlink_to(pty_name)

    log = open(args.log, "a", buffering=1, encoding="utf-8")
    running = True

    def stop(_signum, _frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)

    print(f"Wine COM1 -> {wine_com1} -> {pty_name}", flush=True)
    print(f"Cashier -> {args.device} at {args.baud} 8N1", flush=True)
    print(f"Log -> {args.log}", flush=True)
    print("Open ECR Tool, click ONLY Read currencies, then Ctrl-C here.", flush=True)

    def record(direction: str, data: bytes) -> None:
        if not data:
            return
        log.write(json.dumps({
            "ts": now(),
            "direction": direction,
            "bytesHex": data.hex(),
        }) + "\n")

    try:
        while running:
            ready, _, _ = select.select([master, cashier.fileno()], [], [], 0.5)
            if master in ready:
                data = os.read(master, 4096)
                if data:
                    record("ecr-to-cashier", data)
                    cashier.write(data)
            if cashier.fileno() in ready:
                data = cashier.read(4096)
                if data:
                    record("cashier-to-ecr", data)
                    os.write(master, data)
    finally:
        cashier.close()
        os.close(master)
        os.close(slave)
        log.close()
        print(f"\nCapture stopped. Send {args.log} back for analysis.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
