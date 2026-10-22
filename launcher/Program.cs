using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

namespace QiaojianLauncher
{
    /// <summary>
    /// 桥见柳州 · 免安装启动器。
    ///
    /// 做的事情：
    ///   1. 用 TcpListener 起一个只服务本机的小静态服务器（不依赖 Node / Python / 任何运行时）；
    ///   2. 用系统自带的 Edge（或 Chrome）以 --app 模式打开窗口——
    ///      没有地址栏、没有标签页，看起来就是一个独立应用；
    ///   3. 浏览器窗口关闭后，服务器随之退出，不在后台驻留。
    ///
    /// 之所以不用 HttpListener：它对 127.0.0.1 的前缀需要 URL ACL 授权（要管理员），
    /// 而 TcpListener 直接监听回环端口，普通用户权限即可。
    ///
    /// 调试参数：
    ///   --no-launch   只起服务、不打开浏览器（自动化验收用）
    ///   --port=4173   指定起始端口
    ///   --lan         绑定所有网卡，并把手机可访问的局域网地址弹窗显示出来
    /// </summary>
    internal static class Program
    {
        private static string _root;
        private static readonly Dictionary<string, string> MimeMap = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".html", "text/html; charset=utf-8" },
            { ".htm", "text/html; charset=utf-8" },
            { ".js", "text/javascript; charset=utf-8" },
            { ".mjs", "text/javascript; charset=utf-8" },
            { ".css", "text/css; charset=utf-8" },
            { ".json", "application/json; charset=utf-8" },
            { ".svg", "image/svg+xml" },
            { ".png", "image/png" },
            { ".jpg", "image/jpeg" },
            { ".jpeg", "image/jpeg" },
            { ".gif", "image/gif" },
            { ".webp", "image/webp" },
            { ".ico", "image/x-icon" },
            { ".woff", "font/woff" },
            { ".woff2", "font/woff2" },
            { ".ttf", "font/ttf" },
            { ".wav", "audio/wav" },
            { ".mp3", "audio/mpeg" },
            { ".mp4", "video/mp4" },
            { ".txt", "text/plain; charset=utf-8" },
            { ".md", "text/plain; charset=utf-8" },
            { ".webmanifest", "application/manifest+json" }
        };

        private static int Main(string[] args)
        {
            _root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            var noLaunch = Array.IndexOf(args, "--no-launch") >= 0;
            // --lan：绑定所有网卡，让同一 Wi-Fi 下的手机/平板也能打开
            var wantLan = Array.IndexOf(args, "--lan") >= 0;
            var startPort = 4173;
            foreach (var arg in args)
            {
                if (arg.StartsWith("--port=", StringComparison.Ordinal))
                {
                    int parsed;
                    if (int.TryParse(arg.Substring("--port=".Length), out parsed)) startPort = parsed;
                }
            }

            TcpListener listener = null;
            var port = startPort;
            for (var attempt = 0; attempt < 40; attempt++)
            {
                try
                {
                    var candidate = new TcpListener(wantLan ? IPAddress.Any : IPAddress.Loopback, port);
                    candidate.Start(64);
                    listener = candidate;
                    break;
                }
                catch (SocketException)
                {
                    port++;
                }
            }

            if (listener == null)
            {
                Fail("没有可用端口（4173–4212 都被占用）。");
                return 2;
            }

            var url = "http://127.0.0.1:" + port + "/";
            ThreadPool.QueueUserWorkItem(_ => AcceptLoop(listener));

            var lanUrls = wantLan ? LanUrls(port) : new List<string>();

            if (noLaunch)
            {
                Console.WriteLine(url);
                foreach (var item in lanUrls) Console.WriteLine(item);
                Console.Out.Flush();
                // 调试模式：Ctrl+C 或父进程结束时退出
                Thread.Sleep(Timeout.Infinite);
                return 0;
            }

            if (wantLan)
            {
                // 手机要输入的地址必须看得见：单独开一个信息框，不阻塞主线程
                var message = lanUrls.Count > 0
                    ? "手机 / 平板打开下面任一地址（需与电脑在同一个 Wi-Fi）：\n\n" + string.Join("\n", lanUrls)
                    : "没有找到可用的局域网地址。\n请确认电脑已连接 Wi-Fi 或网线，然后用 --lan 重新启动。";
                var boxThread = new Thread(() => Info(message, "桥见柳州 · 手机访问"));
                boxThread.IsBackground = true;
                boxThread.Start();
            }

            var browser = FindBrowser();
            if (browser == null)
            {
                Fail("没有找到 Microsoft Edge 或 Google Chrome。\n请安装其一后重试，或用浏览器打开：\n" + url);
                listener.Stop();
                return 3;
            }

            var profile = Path.Combine(Path.GetTempPath(), "qiaojian-liuzhou-app");
            var arguments = "\"--app=" + url + "\" --window-size=1440,900 --window-position=40,40 --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check";

            var process = Process.Start(new ProcessStartInfo
            {
                FileName = browser,
                Arguments = arguments,
                UseShellExecute = false,
                WorkingDirectory = _root
            });

            if (process == null)
            {
                Fail("无法启动浏览器窗口。\n请手动打开：" + url);
                listener.Stop();
                return 4;
            }

            // 浏览器窗口关闭 → 服务器退出，不在后台驻留
            process.WaitForExit();
            listener.Stop();
            return 0;
        }

        /// <summary>枚举可用局域网地址（过滤回环、169.254、198.18/19 假地址）。</summary>
        private static List<string> LanUrls(int port)
        {
            var urls = new List<string>();
            try
            {
                foreach (var address in Dns.GetHostAddresses(Dns.GetHostName()))
                {
                    if (address.AddressFamily != AddressFamily.InterNetwork) continue;
                    var text = address.ToString();
                    if (text.StartsWith("127.") || text.StartsWith("169.254.")) continue;
                    if (text.StartsWith("198.18.") || text.StartsWith("198.19.")) continue;
                    urls.Add("http://" + text + ":" + port + "/");
                }
            }
            catch
            {
                // 枚举失败就当没有局域网地址
            }
            return urls;
        }

        private static void Info(string message, string caption)
        {
            try
            {
                System.Windows.Forms.MessageBox.Show(message, caption, System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Information);
            }
            catch
            {
                Console.WriteLine(message);
            }
        }

        private static void Fail(string message)
        {
            try
            {
                System.Windows.Forms.MessageBox.Show(message, "桥见柳州", System.Windows.Forms.MessageBoxButtons.OK, System.Windows.Forms.MessageBoxIcon.Warning);
            }
            catch
            {
                Console.Error.WriteLine(message);
            }
        }

        private static string FindBrowser()
        {
            var candidates = new List<string>
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles, System.Environment.SpecialFolderOption.DoNotVerify), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
            };
            foreach (var candidate in candidates)
            {
                try
                {
                    if (File.Exists(candidate)) return candidate;
                }
                catch
                {
                    // 路径不可访问就跳过
                }
            }
            return null;
        }

        private static void AcceptLoop(TcpListener listener)
        {
            while (true)
            {
                TcpClient client;
                try
                {
                    client = listener.AcceptTcpClient();
                }
                catch
                {
                    return;
                }
                ThreadPool.QueueUserWorkItem(state => Serve((TcpClient)state), client);
            }
        }

        private static void Serve(TcpClient client)
        {
            try
            {
                using (client)
                using (var stream = client.GetStream())
                {
                    client.ReceiveTimeout = 8000;
                    var buffer = new byte[8192];
                    var read = stream.Read(buffer, 0, buffer.Length);
                    if (read <= 0) return;

                    var requestLine = Encoding.ASCII.GetString(buffer, 0, read).Split('\n')[0].Trim();
                    var parts = requestLine.Split(' ');
                    if (parts.Length < 2 || parts[0] != "GET")
                    {
                        Write(stream, 405, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Method Not Allowed"));
                        return;
                    }

                    var target = parts[1];
                    var queryIndex = target.IndexOf('?');
                    if (queryIndex >= 0) target = target.Substring(0, queryIndex);
                    target = Uri.UnescapeDataString(target);
                    if (target.EndsWith("/")) target += "index.html";

                    var relative = target.TrimStart('/').Replace('/', Path.DirectorySeparatorChar);
                    var full = Path.GetFullPath(Path.Combine(_root, relative));

                    // 目录穿越防护：目标必须仍在站点根目录内
                    if (!full.StartsWith(_root, StringComparison.OrdinalIgnoreCase))
                    {
                        Write(stream, 403, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Forbidden"));
                        return;
                    }

                    if (!File.Exists(full))
                    {
                        Write(stream, 404, "text/plain; charset=utf-8", Encoding.UTF8.GetBytes("Not Found: " + target));
                        return;
                    }

                    var extension = Path.GetExtension(full);
                    string mime;
                    if (!MimeMap.TryGetValue(extension, out mime)) mime = "application/octet-stream";
                    var bytes = File.ReadAllBytes(full);
                    Write(stream, 200, mime, bytes);
                }
            }
            catch
            {
                // 单个连接出错不影响服务
            }
        }

        private static void Write(NetworkStream stream, int status, string contentType, byte[] body)
        {
            var reason = status == 200 ? "OK" : status == 403 ? "Forbidden" : status == 404 ? "Not Found" : status == 405 ? "Method Not Allowed" : "Internal Server Error";
            var header = new StringBuilder();
            header.Append("HTTP/1.1 ").Append(status).Append(' ').Append(reason).Append("\r\n");
            header.Append("Content-Type: ").Append(contentType).Append("\r\n");
            header.Append("Content-Length: ").Append(body.Length).Append("\r\n");
            // 交付物随时可能被替换：一律不缓存，避免展厅里看到旧画面
            header.Append("Cache-Control: no-store, must-revalidate\r\n");
            header.Append("Connection: close\r\n");
            header.Append("\r\n");
            var headerBytes = Encoding.ASCII.GetBytes(header.ToString());
            stream.Write(headerBytes, 0, headerBytes.Length);
            stream.Write(body, 0, body.Length);
            stream.Flush();
        }
    }
}
