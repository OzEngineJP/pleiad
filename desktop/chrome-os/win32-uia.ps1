# Chrome's own UI through UI Automation (desktop/chrome-os/win32-uia.cjs, ADR 0218). ASCII only: Windows PowerShell 5.1 reads a BOM-less file as the ANSI code page.
# The request comes in the environment variable PLEIAD_UIA (JSON). One JSON line goes to stdout. No mouse or keyboard input: patterns and posted messages to the given window only.
#   { "op": "allow",  "hwnd": <permission dialog> }            press the allow button of the remote debugging dialog
#   { "op": "navigate", "hwnd": <window Pleiad opened>, "url": "chrome://inspect/#remote-debugging", "nonce": <its title>, "timeoutMs": 8000 }
#                                                                open the page from the address bar of that window (Chrome takes the Enter only while the window is active)
#   { "op": "toggle", "hwnd": <same window>, "timeoutMs": 8000 }  turn the remote debugging switch on (the window need not be active)
$ErrorActionPreference = 'Stop'
function Out-Result($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)) }
try {
  $req = $env:PLEIAD_UIA | ConvertFrom-Json
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[ComImport, Guid("6d5140c1-7436-11ce-8034-00aa006009fa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPleiadServiceProvider { [PreserveSig] int QueryService(ref Guid svc, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
public static class PleiadUia {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr h, int id, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  // Chrome exposes the page contents to accessibility clients only after a screen reader like client asks for IAccessible2.
  public static bool AskForIA2(IntPtr hwnd) {
    Guid iacc = new Guid("618736e0-3c3d-11cf-810c-00aa00389b71");
    Guid ia2 = new Guid("E89F726E-C4F4-4c19-BB19-B647D7FA8478");
    object o;
    if (AccessibleObjectFromWindow(hwnd, -4, ref iacc, out o) != 0 || o == null) return false;
    var sp = o as IPleiadServiceProvider;
    if (sp == null) return false;
    object r;
    return sp.QueryService(ref iacc, ref ia2, out r) == 0 && r != null;
  }
}
"@
  $AE = [System.Windows.Automation.AutomationElement]
  $Scope = [System.Windows.Automation.TreeScope]
  $CT = [System.Windows.Automation.ControlType]
  $hwnd = [IntPtr][long]$req.hwnd
  if (-not [PleiadUia]::IsWindow($hwnd)) { Out-Result @{ ok = $false; reason = 'no-window' }; exit 0 }
  $win = $AE::FromHandle($hwnd)
  function Find-All($root, $type) { $root.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type))) }

  if ($req.op -eq 'allow') {
    # Labels of the allow button. Chrome draws the dialog in its UI language; unknown languages fall back to the manual way.
    $labels = @('Allow', (-join ([char[]](0x8A31, 0x53EF, 0x3059, 0x308B))))
    $hits = @(Find-All $win $CT::Button | Where-Object { $labels -contains $_.Current.Name -and $_.Current.IsEnabled })
    if ($hits.Count -ne 1) { Out-Result @{ ok = $false; reason = $(if ($hits.Count -eq 0) { 'no-button' } else { 'ambiguous' }) }; exit 0 }
    $hits[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Out-Result @{ ok = $true }
    exit 0
  }

  if ($req.op -eq 'navigate') {
    $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$req.timeoutMs)
    $edit = $null
    while (-not $edit -and [DateTime]::UtcNow -lt $deadline) {
      # The first edit box in tree order is the address bar (the toolbar comes before the page; Pleiad's own page has no edit box)
      $edit = Find-All $win $CT::Edit | Select-Object -First 1
      if (-not $edit) { Start-Sleep -Milliseconds 200 }
    }
    if (-not $edit) { Out-Result @{ ok = $false; reason = 'no-address-bar' }; exit 0 }
    $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$req.url)
    Start-Sleep -Milliseconds 150
    [void][PleiadUia]::PostMessage($hwnd, 0x0100, [IntPtr]0x0D, [IntPtr]0x001C0001)
    [void][PleiadUia]::PostMessage($hwnd, 0x0101, [IntPtr]0x0D, [IntPtr]([long]0xC01C0001))
    # The window title carries the nonce until the page changes
    $nonce = [string]$req.nonce
    while ($nonce -and $win.Current.Name.Contains($nonce) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 50 }
    $moved = -not ($nonce -and $win.Current.Name.Contains($nonce))
    Out-Result @{ ok = $moved; reason = $(if ($moved) { $null } else { 'not-navigated' }) }
    exit 0
  }

  if ($req.op -eq 'toggle') {
    $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$req.timeoutMs)
    $box = $null
    while (-not $box -and [DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds 300
      [void][PleiadUia]::AskForIA2($hwnd)
      $box = Find-All $win $CT::CheckBox | Where-Object { $_.Current.Name -match 'remote debugging' } | Select-Object -First 1
    }
    if (-not $box) { Out-Result @{ ok = $false; reason = 'no-switch' }; exit 0 }
    $toggle = $box.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    $was = [string]$toggle.Current.ToggleState
    if ($was -ne 'On') {
      $toggle.Toggle()
      $until = [DateTime]::UtcNow.AddSeconds(3)
      while ([string]$toggle.Current.ToggleState -ne 'On' -and [DateTime]::UtcNow -lt $until) { Start-Sleep -Milliseconds 100 }
    }
    $now = [string]$toggle.Current.ToggleState
    Out-Result @{ ok = ($now -eq 'On'); reason = $(if ($now -eq 'On') { $null } else { 'not-toggled' }); was = $was }
    exit 0
  }
  Out-Result @{ ok = $false; reason = 'unknown-op' }
} catch {
  Out-Result @{ ok = $false; reason = 'error'; error = ($_.Exception.Message -replace '\s+', ' ').Substring(0, [Math]::Min(200, ($_.Exception.Message -replace '\s+', ' ').Length)) }
}
