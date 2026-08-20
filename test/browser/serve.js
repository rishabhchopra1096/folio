/* Serves the real Folio tree plus the probe page, and records assertions. */
const http = require("http"), fs = require("fs"), path = require("path");
const ROOT = "/Users/rishabhchopra/Documents/GitHub/folio";
const TYPES = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css",
                ".json":"application/json", ".svg":"image/svg+xml", ".png":"image/png" };
http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  if (req.url.startsWith("/r?")) {
    fs.appendFileSync(__dirname + "/out.log", decodeURIComponent(req.url.slice(3)).replace(/&_=.*$/, "") + "\n");
    res.end("ok"); return;
  }
  /* Probes live beside this file; everything else is the real app tree. */
  const file = u.endsWith(".probe.html") ? path.join(__dirname, path.basename(u))
             : u === "/probe.html"       ? path.join(__dirname, "import.probe.html")
                                         : path.join(ROOT, u === "/" ? "/index.html" : u);
  if (!file.startsWith(ROOT) && !file.startsWith(__dirname)) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.statusCode = 404; return res.end("nf"); }
    res.setHeader("content-type", TYPES[path.extname(file)] || "application/octet-stream");
    res.end(buf);
  });
}).listen(8810, () => console.log("serving"));
