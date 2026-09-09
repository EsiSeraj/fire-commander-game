#!/usr/bin/env python3
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import errno
import socket
import sys
import webbrowser


START_PORT = 8000
MAX_PORT = 8999


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        print("%s - %s" % (self.address_string(), format % args))


def localhost_port_is_taken(port):
    targets = [("127.0.0.1", port), ("::1", port)]
    for target in targets:
        try:
            with socket.create_connection(target, timeout=0.2):
                return True
        except OSError:
            pass
    return False


def create_server(directory):
    handler = partial(QuietHandler, directory=str(directory))

    for port in range(START_PORT, MAX_PORT + 1):
        if localhost_port_is_taken(port):
            continue
        try:
            return port, ThreadingHTTPServer(("127.0.0.1", port), handler)
        except OSError as error:
            if error.errno in {errno.EADDRINUSE, errno.EACCES}:
                continue
            raise

    raise RuntimeError(f"No available localhost port between {START_PORT} and {MAX_PORT}.")


def main():
    game_dir = Path(__file__).resolve().parent
    port, server = create_server(game_dir)
    url = f"http://localhost:{port}/"

    print("FireCommander is running.")
    print(f"Game folder: {game_dir}")
    print(f"Opening: {url}")
    print("Keep this window open while playing. Press Ctrl+C to stop the server.")

    webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping FireCommander.")
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except socket.error as error:
        print(f"Could not start FireCommander: {error}", file=sys.stderr)
        sys.exit(1)
    except RuntimeError as error:
        print(error, file=sys.stderr)
        sys.exit(1)
