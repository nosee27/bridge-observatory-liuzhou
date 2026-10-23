using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace QiaojianLauncher
{
    /// <summary>
    /// 桥见柳州 · 启动器。源码编译两次，得到两个互不干扰的程序：
    ///
    ///   桥见柳州.exe（本地版，未定义 LAN_EDITION）
    ///     只绑 127.0.0.1，只在本机打开桌面窗口；不开放局域网、不改防火墙。
    ///
    ///   桥见柳州-手机访问.exe（局域网版，/define:LAN_EDITION）
    ///     绑 0.0.0.0，只为同 Wi-Fi 的手机/平板服务：自动确保防火墙放行，
    ///     弹出可复制的地址窗口，**不打开本地桌面窗口**。
    ///
    /// 两个版本共用同一套静态服务代码，行为差异全部在编译期决定，
    /// 避免"同一个程序靠参数切换"导致用户点错入口。
    ///
    /// 参数（两版通用）：
    ///   --port=4173         指定起始端口（默认从 4173 起找空位）
    ///   --no-launch         只起服务、不开任何窗口（自动化验收用）
    ///   --no-firewall       跳过防火墙处理（局域网版调试用）
    ///   --add-firewall-only 只加防火墙规则然后退出（内部用于提权重启）
    /// </summary>
    internal static class Program
    {
#if LAN_EDITION
        /// <summary>局域网版：对外服务，不打开本地窗口。</summary>
        private const bool LanEdition = true;
        private const string RuleNameExe = "Bridge Observatory (lan)";
#else
        /// <summary>本地版：只服务本机，不开放局域网。</summary>
        private const bool LanEdition = false;
        private const string RuleNameExe = "Bridge Observatory (local)";
#endif
        private const string RuleNamePort = "Bridge Observatory (port)";

#if LAN_EDITION
        private const string EditionName = "桥见柳州-手机访问";
        private static Mutex _instanceMutex;
#else
        private const string EditionName = "桥见柳州";
        private static Mutex _instanceMutex;
#endif

        /// <summary>同一时间只允许一个实例（--no-launch 的自动化测试除外）。</summary>
        private static bool AcquireSingleInstance()
        {
            try
            {
                bool createdNew;
                _instanceMutex = new Mutex(true, "Local\\QiaojianLiuzhou-" + EditionName, out createdNew);
                return createdNew;
            }
            catch
            {
                // 互斥量创建失败不该阻止程序启动
                return true;
            }
        }

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

        [STAThread]
        private static int Main(string[] args)
        {
            _root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);

            var noLaunch = Array.IndexOf(args, "--no-launch") >= 0;
            var skipFirewall = Array.IndexOf(args, "--no-firewall") >= 0;
            var addFirewallOnly = Array.IndexOf(args, "--add-firewall-only") >= 0;

            if (addFirewallOnly)
            {
                return AddFirewallRules() ? 0 : 1;
            }

            // 版本决定绑定范围：本地版只回环，局域网版绑全部网卡
            var localOnly = !LanEdition;

            var startPort = 4173;
            foreach (var arg in args)
            {
                if (arg.StartsWith("--port=", StringComparison.Ordinal))
                {
                    int parsed;
                    if (int.TryParse(arg.Substring("--port=".Length), out parsed)) startPort = parsed;
                }
            }

            /*
             * 启动阶段绝不提权。
             *
             * 原来这里会 Process.Start(自己, Verb="runas") 去补防火墙规则，
             * 于是双击程序时先弹一次 UAC；若系统里已有一个以管理员身份运行的实例，
             * Windows 会拒绝再启动一个提升的副本，并在界面上给出
             * “现有实例正在以提升的权限运行”这类提示——用户看到的就是这句。
             *
             * 现在改成：启动时只用 netsh **读**规则（不需要管理员），
             * 需要放行时由地址窗口里的按钮按需触发一次提权。
             */
            var firewallOk = localOnly || skipFirewall || FirewallAlreadyAllowed();

            // 单实例：避免同时跑两个服务导致端口漂移、规则指向混乱
            if (!noLaunch && !AcquireSingleInstance())
            {
                Fail("“" + EditionName + "”已经在运行了。\n请查看它已经打开的窗口；\n如果要重启，先关闭那个窗口。");
                return 5;
            }

            TcpListener listener = null;
            var port = startPort;
            for (var attempt = 0; attempt < 40; attempt++)
            {
                try
                {
                    var candidate = new TcpListener(localOnly ? IPAddress.Loopback : IPAddress.Any, port);
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
                Fail("没有可用端口（4173–4212 都被占用）。请关闭占用端口的程序后重试。");
                return 2;
            }

            var localUrl = "http://127.0.0.1:" + port + "/";
            var lanUrls = localOnly ? new List<string>() : LanUrls(port);

            ThreadPool.QueueUserWorkItem(_ => AcceptLoop(listener));

            if (noLaunch)
            {
                Console.WriteLine(localUrl);
                foreach (var item in lanUrls) Console.WriteLine(item);
                Console.Out.Flush();
                Thread.Sleep(Timeout.Infinite);
                return 0;
            }

#if LAN_EDITION
            // 局域网版：不打开本地桌面窗口，地址窗口就是主界面——关掉它即停止服务
            if (noLaunch)
            {
                Console.WriteLine(localUrl);
                foreach (var item in lanUrls) Console.WriteLine(item);
                Console.Out.Flush();
                Thread.Sleep(Timeout.Infinite);
                return 0;
            }

            Application.Run(BuildAccessForm(lanUrls, firewallOk, IsAdmin()));
            listener.Stop();
            return 0;
#else
            // 本地版：只在本机浏览器里打开，不弹地址窗、不碰防火墙
            if (noLaunch)
            {
                Console.WriteLine(localUrl);
                Console.Out.Flush();
                Thread.Sleep(Timeout.Infinite);
                return 0;
            }

            var browser = FindBrowser();
            if (browser == null)
            {
                Fail("没有找到 Microsoft Edge 或 Google Chrome。\n请安装其一后重试，或手动打开：\n" + localUrl);
                listener.Stop();
                return 3;
            }

            /*
             * 每次启动用独立的临时配置目录（带进程号）。
             *
             * 原来固定用 %TEMP%\qiaojian-liuzhou-app：只要上一次的 Edge 还活着
             * （比如服务已经停了、窗口还开着），下一次启动就会撞上同一个 profile 锁，
             * Edge 便弹出"现有实例正在以提升的权限运行，是否以普通权限重启现有实例"。
             * 独立目录从根上避免这种互相锁。
             */
            var profile = Path.Combine(Path.GetTempPath(), "qiaojian-liuzhou-app-" + Process.GetCurrentProcess().Id);
            var arguments = "\"--app=" + localUrl + "\" --window-size=1440,900 --window-position=40,40 --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check";

            var process = Process.Start(new ProcessStartInfo
            {
                FileName = browser,
                Arguments = arguments,
                UseShellExecute = false,
                WorkingDirectory = _root
            });

            if (process == null)
            {
                Fail("无法启动浏览器窗口。\n请手动打开：" + localUrl);
                listener.Stop();
                return 4;
            }

            // 浏览器若在 3 秒内就退出，多半是被拦或配置锁冲突：退回系统默认浏览器，
            // 至少让画面能打开（此时服务继续跑，用户关掉控制台/再双击才会停）。
            var exitedFast = process.WaitForExit(3000);
            if (exitedFast)
            {
                try
                {
                    Process.Start(new ProcessStartInfo(localUrl) { UseShellExecute = true });
                }
                catch
                {
                    // 打不开就保持服务运行，用户可手动访问
                }
                WaitForAnyInput();
            }
            else
            {
                process.WaitForExit();
            }

            TryDeleteProfile(profile);
            listener.Stop();
            return 0;
#endif
        }

        /* ---------------- 防火墙 ---------------- */

        private static bool IsAdmin()
        {
            try
            {
                return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
            }
            catch
            {
                return false;
            }
        }

        /// <summary>规则是否已存在：看 netsh show rule 的退出码（0=有，1=没有），不解析本地化文案。</summary>
        private static bool RuleExists()
        {
            return Netsh("advfirewall firewall show rule name=\"" + RuleNameExe + "\"").Ok
                && Netsh("advfirewall firewall show rule name=\"" + RuleNamePort + "\"").Ok;
        }

        /// <summary>
        /// 标记文件：记录"哪一份 exe 路径已经放行过"。
        /// 规则名是按版本区分的，但 exe 可能被移动/改名——那时旧规则指向旧路径，手机仍连不上。
        /// 用标记 + 规则存在两个条件一起判断，既不会反复弹 UAC，也能在 exe 移动后重新放行。
        /// </summary>
        private static string MarkerPath()
        {
            var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QiaojianLiuzhou");
            return Path.Combine(folder, "firewall-allowed.txt");
        }

        private static string ReadMarker()
        {
            try
            {
                var path = MarkerPath();
                return File.Exists(path) ? File.ReadAllText(path).Trim() : string.Empty;
            }
            catch
            {
                return string.Empty;
            }
        }

        private static void WriteMarker()
        {
            try
            {
                var path = MarkerPath();
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                File.WriteAllText(path, Application.ExecutablePath);
            }
            catch
            {
                // 写不了标记不影响使用，只是下次可能再问一次
            }
        }

        /// <summary>只读判断：当前这份 exe 是否已经被防火墙放行（netsh show 不需要管理员）。</summary>
        private static bool FirewallAlreadyAllowed()
        {
            if (!RuleExists()) return false;
            return string.Equals(ReadMarker(), Application.ExecutablePath, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>
        /// 按需提权放行（由地址窗口的按钮触发，启动时不调用）。
        /// 成功返回 true；用户取消 UAC 或系统拒绝时返回 false。
        /// </summary>
        private static bool RequestFirewallAccess()
        {
            if (IsAdmin()) return AddFirewallRules();

            try
            {
                var elevate = Process.Start(new ProcessStartInfo
                {
                    FileName = Application.ExecutablePath,
                    Arguments = "--add-firewall-only",
                    Verb = "runas",
                    UseShellExecute = true
                });
                if (elevate == null) return false;
                elevate.WaitForExit();
                return FirewallAlreadyAllowed();
            }
            catch
            {
                // 用户点了「否」，或系统禁止提权
                return false;
            }
        }

        private static bool AddFirewallRules()
        {
            var exePath = Application.ExecutablePath;
            // 顺手清掉旧版本（未拆版）留下的通用规则名，避免出现指向旧路径的僵尸规则
            Netsh("advfirewall firewall delete rule name=\"Bridge Observatory (exe)\"");

            Netsh("advfirewall firewall delete rule name=\"" + RuleNameExe + "\"");
            Netsh("advfirewall firewall delete rule name=\"" + RuleNamePort + "\"");
            var okExe = Netsh("advfirewall firewall add rule name=\"" + RuleNameExe + "\" dir=in action=allow program=\"" + exePath + "\" enable=yes profile=any").Ok;
            var okPort = Netsh("advfirewall firewall add rule name=\"" + RuleNamePort + "\" dir=in action=allow protocol=TCP localport=4173-4212 profile=any").Ok;

            // node.js 也顺手放行（用 node server.js --lan 时手机同样能连）
            var node = FindNode();
            if (!string.IsNullOrEmpty(node))
            {
                Netsh("advfirewall firewall delete rule name=\"Bridge Observatory (node)\"");
                Netsh("advfirewall firewall add rule name=\"Bridge Observatory (node)\" dir=in action=allow program=\"" + node + "\" enable=yes profile=any");
            }

            if (okExe && okPort) WriteMarker();
            return okExe && okPort;
        }

        private static string FindNode()
        {
            var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            foreach (var folder in path.Split(';'))
            {
                if (string.IsNullOrWhiteSpace(folder)) continue;
                try
                {
                    var candidate = Path.Combine(folder.Trim(), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch
                {
                    // 忽略非法路径
                }
            }
            return null;
        }

        private struct NetshResult
        {
            public bool Ok;
            public string Output;
        }

        private static NetshResult Netsh(string arguments)
        {
            var result = new NetshResult { Ok = false, Output = string.Empty };
            try
            {
                var info = new ProcessStartInfo("netsh", arguments)
                {
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using (var process = Process.Start(info))
                {
                    if (process == null) return result;
                    var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
                    if (!process.WaitForExit(10000))
                    {
                        try
                        {
                            process.Kill();
                        }
                        catch
                        {
                            // 进程可能已经退出
                        }
                        return result;
                    }
                    result.Ok = process.ExitCode == 0;
                    result.Output = output ?? string.Empty;
                    return result;
                }
            }
            catch
            {
                return result;
            }
        }

        private static void TryDeleteProfile(string profile)
        {
            try
            {
                if (Directory.Exists(profile)) Directory.Delete(profile, true);
            }
            catch
            {
                // Edge 可能还有后台进程占着，删不掉就算了（下次启动用的是新目录）
            }
        }

        /// <summary>浏览器被拦时，让服务继续跑一会儿，而不是立刻退出。</summary>
        private static void WaitForAnyInput()
        {
            try
            {
                var form = new Form
                {
                    Text = "桥见柳州 · 服务运行中",
                    ClientSize = new Size(460, 150),
                    StartPosition = FormStartPosition.CenterScreen,
                    TopMost = true,
                    FormBorderStyle = FormBorderStyle.FixedDialog,
                    MaximizeBox = false,
                    MinimizeBox = false
                };
                var label = new Label
                {
                    Text = "浏览器窗口没能打开（可能被系统拦截或与已有实例冲突）。\n服务仍在运行，可手动访问地址栏里的链接；\n关闭这个窗口即停止服务。",
                    Dock = DockStyle.Fill,
                    Padding = new Padding(16),
                    TextAlign = ContentAlignment.MiddleLeft
                };
                var stop = new Button { Text = "停止服务", Dock = DockStyle.Bottom, Height = 40 };
                stop.Click += (sender, eventArgs) => form.Close();
                form.Controls.Add(label);
                form.Controls.Add(stop);
                Application.Run(form);
            }
            catch
            {
                // 无桌面环境时直接返回
            }
        }

        /* ---------------- 手机地址窗口 ---------------- */

        private static Form BuildAccessForm(List<string> lanUrls, bool firewallOk, bool runningAsAdmin)
        {
            var form = new Form
            {
                Text = "桥见柳州 · 手机访问",
                ClientSize = new Size(560, 300),
                StartPosition = FormStartPosition.CenterScreen,
                TopMost = true,
                MaximizeBox = false,
                MinimizeBox = false,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                Font = new Font("Microsoft YaHei UI", 9F)
            };

            var title = new Label
            {
                Text = "手机浏览器打开下面任一地址（需与电脑连同一个 Wi-Fi）",
                Dock = DockStyle.Top,
                Height = 42,
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(14, 0, 0, 0),
                Font = new Font("Microsoft YaHei UI", 11F, FontStyle.Bold)
            };

            var addressBox = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                Dock = DockStyle.Fill,
                Font = new Font("Consolas", 13F),
                BackColor = Color.White,
                Text = lanUrls.Count > 0
                    ? string.Join(Environment.NewLine, lanUrls)
                    : "未找到局域网地址：请先确认电脑已连接 Wi-Fi 或网线。"
            };

            var hint = new Label
            {
                Text = firewallOk
                    ? (runningAsAdmin
                        ? "防火墙已放行。注意：当前以管理员身份运行，浏览器可能提示权限冲突；建议普通双击。"
                        : "防火墙已放行。关闭这个窗口即停止服务。")
                    : "防火墙尚未放行：手机可能连不上。点右侧按钮按需授权（只需一次）。",
                Dock = DockStyle.Bottom,
                Height = 46,
                TextAlign = ContentAlignment.MiddleLeft,
                Padding = new Padding(14, 0, 0, 0),
                ForeColor = firewallOk ? Color.DimGray : Color.Firebrick
            };

            var buttons = new FlowLayoutPanel
            {
                Dock = DockStyle.Bottom,
                FlowDirection = FlowDirection.RightToLeft,
                Height = 50,
                Padding = new Padding(10, 8, 10, 8)
            };

            var close = new Button { Text = "停止服务", AutoSize = true, MinimumSize = new Size(96, 32) };
            close.Click += (sender, eventArgs) => form.Close();

            var copy = new Button { Text = "复制地址", AutoSize = true, MinimumSize = new Size(96, 32) };
            copy.Click += (sender, eventArgs) =>
            {
                if (lanUrls.Count == 0) return;
                try
                {
                    Clipboard.SetText(lanUrls[0]);
                    copy.Text = "已复制";
                }
                catch
                {
                    // 剪贴板偶尔会被别的程序占用
                }
            };

            buttons.Controls.Add(close);
            buttons.Controls.Add(copy);

            if (!firewallOk)
            {
                var allow = new Button { Text = "放行防火墙", AutoSize = true, MinimumSize = new Size(110, 32) };
                allow.Click += (sender, eventArgs) =>
                {
                    allow.Enabled = false;
                    allow.Text = "等待授权…";
                    var granted = RequestFirewallAccess();
                    allow.Enabled = true;
                    if (granted)
                    {
                        allow.Visible = false;
                        hint.Text = "防火墙已放行。关闭这个窗口即停止服务。";
                        hint.ForeColor = Color.DimGray;
                    }
                    else
                    {
                        allow.Text = "放行防火墙";
                        hint.Text = "仍未放行（授权被取消或系统拒绝）。手机可能连不上；也可改用静态托管。";
                        hint.ForeColor = Color.Firebrick;
                    }
                };
                buttons.Controls.Add(allow);
            }

            form.Controls.Add(addressBox);
            form.Controls.Add(title);
            form.Controls.Add(buttons);
            form.Controls.Add(hint);
            return form;
        }

        /* ---------------- 站点服务 ---------------- */

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
                    // 198.18/19 是 Clash 之类 TUN 的假地址，手机连不上
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

        private static void Fail(string message)
        {
            try
            {
                MessageBox.Show(message, "桥见柳州", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
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
