# ECR Tool read capture (host only)

Goal: capture the exact bytes the Win ECR Tool sends **after** the known `002: 004:` preflight when you click **Read currencies**, plus the cashier's response. No Save, no write.

Run this on the **host** with the cashier attached. Do not run it in the DSH Docker container.

## Host prerequisites

- Python 3 with pyserial: `python3 -m pip install pyserial`
- Wine with the ECR Tool installed
- Cashier serial device (`ls /dev/cu.*` on macOS)
- The cashier not open in the browser/another app

## Steps

1. Stop the browser app; only one process may own the serial device.
2. Find the cashier device, for example `/dev/cu.usbmodem1234`.
3. Start the proxy:

```bash
python3 tools/ecr-read-capture/proxy.py \
  --device /dev/cu.usbmodem1234 \
  --baud 9600 \
  --log ecr-read-capture.jsonl \
  --wine-prefix "$HOME/.wine-ecrtool"
```

Use the real Wine prefix that contains the ECR Tool; adjust the path.

4. Start the ECR Tool through Wine. It uses **COM1**, which the proxy pointed at its PTY.
5. In ECR Tool, open **Currencies** and click **Read currencies only**.
6. Wait for the operation to finish. Do **not** click any Save button.
7. Stop the proxy with Ctrl-C.
8. Send `ecr-read-capture.jsonl` back for protocol analysis.

## Safety

- The proxy forwards bytes; it never constructs or sends a command.
- The only action on the cashier must be **Read currencies**. A Save would be forwarded and is a write.
- If the ECR Tool cannot open COM1, check that the proxy is still running and that the Wine prefix path is correct.
- Keep the cashier connected until the capture file is closed.
