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

## Troubleshooting

### `Device not configured` on the cashier

- Close Chrome and every other app holding the port.
- Check the holder: `lsof /dev/cu.usbmodem1101`
- Try the dial-in node instead of the callout node:

```bash
--device /dev/tty.usbmodem1101
```

- Re-run `ls /dev/cu.*` after the error; the device may have re-enumerated.
- The proxy now asserts DTR and RTS and uses exclusive open.

### ECR Tool cannot connect / log stays empty

The proxy log is empty because ECR Tool is not reaching the PTY. Do **not** send arbitrary bytes to COM1 while the cashier is connected; every byte is forwarded to the device. Diagnose by inspecting the symlink and launching ECR Tool:

```bash
ls -l "$WINEPREFIX/dosdevices/com1"
```

If ECR Tool still cannot connect:

1. Confirm the symlink while the proxy runs:
   `ls -l "$WINEPREFIX/dosdevices/com1"`
2. Start the ECR Tool **after** the proxy; restart Wine/ECR Tool after changing COM1.
3. In `winecfg`, confirm COM1 is the expected port.
4. Check the ECR Tool's saved port setting; it must use COM1 at 9600.
5. If the ECR Tool still cannot open COM1, it may be running on a different Wine/CrossOver/Whisky prefix; use that prefix.
