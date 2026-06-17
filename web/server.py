import os, sys, functools, http.server, socketserver

DIR = "/Users/chasencampbell/Downloads/MacB-Handoff/sportacle/web"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8788

# chdir to an absolute path first so we never call os.getcwd() in a restricted cwd.
os.chdir(DIR)
Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=DIR)

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

with Server(("127.0.0.1", PORT), Handler) as httpd:
    print("serving " + DIR + " on http://127.0.0.1:" + str(PORT))
    httpd.serve_forever()
