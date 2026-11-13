# 清掉 DSH 窗口的「始终置顶」标记（只改 z 序标志，不碰 DSH 的文件与设置）
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class UntopDsh {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public static int Clear(IntPtr h) {
    int ex = GetWindowLongW(h, -20);
    if ((ex & 0x8) == 0) return 0;
    SetWindowPos(h, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    return 1;
  }
}
"@
$procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'DSH*' }
$pids = @{}
foreach ($p in $procs) { $pids[[uint32]$p.Id] = $p.ProcessName }
Write-Output ("DSH 进程: " + (($pids.Values | Sort-Object -Unique) -join ', '))
$script:n = 0
[UntopDsh]::EnumWindows({ param($h, $l)
  if ([UntopDsh]::IsWindowVisible($h)) {
    $wpid = 0
    [void][UntopDsh]::GetWindowThreadProcessId($h, [ref]$wpid)
    if ($pids.ContainsKey([uint32]$wpid)) {
      if ([UntopDsh]::Clear($h) -eq 1) {
        $sb = New-Object System.Text.StringBuilder 256
        [void][UntopDsh]::GetWindowTextW($h, $sb, 256)
        Write-Output ("取消置顶: " + $sb.ToString())
        $script:n++
      }
    }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
Write-Output ("完成，处理了 " + $script:n + " 个窗口。")
