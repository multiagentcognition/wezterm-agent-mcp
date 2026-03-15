local wezterm = require 'wezterm'
local config = wezterm.config_builder()

config.font_size = 11
config.color_scheme = 'Catppuccin Mocha'
config.window_padding = { left = 2, right = 2, top = 2, bottom = 2 }
config.initial_cols = 400
config.initial_rows = 100
config.exit_behavior = 'Hold'
config.window_close_confirmation = 'NeverPrompt'
config.use_fancy_tab_bar = false
config.tab_bar_at_bottom = false
config.tab_max_width = 40

config.unix_domains = {
  { name = 'macp' },
}

config.keys = {
  { key = 'F11', action = wezterm.action.ToggleFullScreen },
  { key = 'f', mods = 'ALT', action = wezterm.action.ToggleFullScreen },
}

wezterm.on('gui-startup', function(cmd)
  local tab, pane, window = wezterm.mux.spawn_window(cmd or {})
  window:gui_window():maximize()
end)

wezterm.on('format-window-title', function(tab, pane, tabs, panes, cfg)
  local project = nil
  local my_path = ''
  for _, t in ipairs(tabs) do
    for _, p in ipairs(t.panes) do
      local cwd = p.current_working_dir
      if cwd then
        local path = tostring(cwd):gsub('^file://[^/]*', ''):gsub('/$', '')
        local name = path:match('/([^/]+)$')
        if name and #name > 0 and name ~= '~' then
          project = name
          my_path = path
          break
        end
      end
    end
    if project then break end
  end
  if not project then return pane.title end
  local ok, result = pcall(function()
    local all_windows = wezterm.mux.all_windows()
    local same_project = {}
    local my_window_id = nil
    for _, w in ipairs(all_windows) do
      local w_tabs = w:tabs()
      if w_tabs and #w_tabs > 0 then
        local first_pane = w_tabs[1]:panes()[1]
        if first_pane then
          local w_cwd = tostring(first_pane:get_current_working_dir() or ''):gsub('^file://[^/]*', ''):gsub('/$', '')
          local w_project = w_cwd:match('/([^/]+)$')
          if w_project == project then
            table.insert(same_project, w:window_id())
          end
        end
        for _, t in ipairs(w_tabs) do
          if t:tab_id() == tab.tab_id then
            my_window_id = w:window_id()
          end
        end
      end
    end
    if #same_project > 1 and my_window_id then
      table.sort(same_project)
      for i, wid in ipairs(same_project) do
        if wid == my_window_id then
          return project .. ' ' .. i .. '/' .. #same_project
        end
      end
    end
    return project
  end)
  if ok and result then return result end
  return project
end)

wezterm.on('update-right-status', function(window, pane)
  local workspace = window:active_workspace()
  local info = pane:get_title()
  window:set_right_status(wezterm.format({
    { Foreground = { Color = '#89b4fa' } },
    { Text = ' ' .. workspace .. ' ' },
    'ResetAttributes',
    { Foreground = { Color = '#a6adc8' } },
    { Text = ' | ' .. info .. ' ' },
  }))
end)

wezterm.on('format-tab-title', function(tab)
  local counts = {}
  local total = 0
  for _, p in ipairs(tab.panes) do
    local name = 'shell'
    local t = p.title:lower()
    if t:find('claude') then name = 'Claude'
    elseif t:find('gemini') then name = 'Gemini'
    elseif t:find('codex') then name = 'Codex'
    elseif t:find('opencode') then name = 'OpenCode'
    elseif t:find('goose') then name = 'Goose'
    end
    counts[name] = (counts[name] or 0) + 1
    total = total + 1
  end
  local parts = {}
  for _, cli in ipairs({'Claude', 'Gemini', 'Codex', 'OpenCode', 'Goose'}) do
    if counts[cli] then
      if counts[cli] > 1 then
        table.insert(parts, cli .. ' (' .. counts[cli] .. ')')
      else
        table.insert(parts, cli)
      end
    end
  end
  if counts['shell'] then
    if #parts > 0 then
      table.insert(parts, 'shell')
    else
      if counts['shell'] > 1 then
        table.insert(parts, 'shell (' .. counts['shell'] .. ')')
      else
        table.insert(parts, 'shell')
      end
    end
  end
  local title = table.concat(parts, ' + ')
  if #title == 0 then title = 'empty' end
  local index = tab.tab_index + 1
  return ' ' .. index .. ': ' .. title .. ' '
end)

return config
