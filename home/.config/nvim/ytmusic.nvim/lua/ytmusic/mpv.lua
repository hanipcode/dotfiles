--- Manages the mpv process and talks to it over its JSON IPC socket.
--- https://mpv.io/manual/stable/#json-ipc
local uv = vim.uv or vim.loop
local config = require("ytmusic.config")

local M = {
	job = nil,
	pipe = nil,
	connected = false,
	sock = nil,
	-- last known values of observed properties
	props = {},
}

local pending = {} -- request_id -> callback
local req_id = 0
local prop_handlers = {} -- property name -> list of callbacks
local event_handlers = {} -- event name -> list of callbacks
local exit_handlers = {}
local readbuf = ""

local OBSERVED = { "pause", "duration", "playlist-pos", "playlist-count", "media-title", "volume", "idle-active" }

function M.is_running()
	return M.job ~= nil and M.connected
end

function M.on_prop(name, fn)
	prop_handlers[name] = prop_handlers[name] or {}
	table.insert(prop_handlers[name], fn)
end

function M.on_event(name, fn)
	event_handlers[name] = event_handlers[name] or {}
	table.insert(event_handlers[name], fn)
end

function M.on_exit(fn)
	table.insert(exit_handlers, fn)
end

local function handle_message(msg)
	if msg.request_id then
		local cb = pending[msg.request_id]
		pending[msg.request_id] = nil
		if cb then
			cb(msg)
		end
	elseif msg.event == "property-change" and msg.name then
		M.props[msg.name] = msg.data
		for _, fn in ipairs(prop_handlers[msg.name] or {}) do
			fn(msg.data)
		end
	elseif msg.event then
		for _, fn in ipairs(event_handlers[msg.event] or {}) do
			fn(msg)
		end
	end
end

local function on_data(data)
	readbuf = readbuf .. data
	while true do
		local nl = readbuf:find("\n", 1, true)
		if not nl then
			break
		end
		local line = readbuf:sub(1, nl - 1)
		readbuf = readbuf:sub(nl + 1)
		if line ~= "" then
			local ok, msg = pcall(vim.json.decode, line)
			if ok and type(msg) == "table" then
				vim.schedule(function()
					handle_message(msg)
				end)
			end
		end
	end
end

--- Send a raw mpv command, e.g. M.send({ "loadfile", url, "append-play" })
function M.send(command, cb)
	if not (M.pipe and M.connected) then
		if cb then
			cb({ error = "not connected" })
		end
		return false
	end
	req_id = req_id + 1
	if cb then
		pending[req_id] = cb
	end
	M.pipe:write(vim.json.encode({ command = command, request_id = req_id }) .. "\n")
	return true
end

function M.get(prop, cb)
	M.send({ "get_property", prop }, function(res)
		cb(res.data, res.error ~= "success" and res.error or nil)
	end)
end

function M.set(prop, value, cb)
	M.send({ "set_property", prop, value }, cb)
end

local function reset()
	if M.pipe then
		pcall(function()
			M.pipe:read_stop()
			M.pipe:close()
		end)
	end
	M.pipe = nil
	M.job = nil
	M.connected = false
	M.props = {}
	pending = {}
	readbuf = ""
	for _, fn in ipairs(exit_handlers) do
		fn()
	end
end

local function connect(cb)
	local tries = 0
	local function attempt()
		if not M.job then
			if cb then
				cb(false)
			end
			return
		end
		tries = tries + 1
		local pipe = uv.new_pipe(false)
		pipe:connect(M.sock, function(err)
			if err then
				pipe:close()
				if tries < 50 then
					vim.defer_fn(attempt, 100)
				else
					vim.schedule(function()
						vim.notify("[ytmusic] could not connect to mpv IPC socket", vim.log.levels.ERROR)
						if cb then
							cb(false)
						end
					end)
				end
				return
			end
			M.pipe = pipe
			M.connected = true
			pipe:read_start(function(rerr, data)
				if rerr or not data then
					return
				end
				on_data(data)
			end)
			vim.schedule(function()
				for i, prop in ipairs(OBSERVED) do
					M.send({ "observe_property", i, prop })
				end
				if cb then
					cb(true)
				end
			end)
		end)
	end
	vim.defer_fn(attempt, 150)
end

--- Start mpv (if not already running) and connect to it. cb(ok) is called when ready.
function M.start(cb)
	if M.is_running() then
		if cb then
			cb(true)
		end
		return
	end
	if M.job then
		-- spawn in flight; retry shortly
		vim.defer_fn(function()
			M.start(cb)
		end, 200)
		return
	end

	local cfg = config.options
	if vim.fn.executable(cfg.mpv.bin) ~= 1 then
		vim.notify("[ytmusic] mpv not found (`" .. cfg.mpv.bin .. "`). brew install mpv", vim.log.levels.ERROR)
		if cb then
			cb(false)
		end
		return
	end

	M.sock = vim.fn.tempname() .. "-ytmusic.sock"
	local args = {
		cfg.mpv.bin,
		"--no-video",
		"--idle=yes",
		"--no-terminal",
		"--really-quiet",
		"--volume-max=100",
		"--input-ipc-server=" .. M.sock,
		"--volume=" .. tostring(cfg.volume),
		"--ytdl-format=" .. cfg.audio_format,
	}
	vim.list_extend(args, cfg.mpv.extra_args or {})

	M.job = vim.fn.jobstart(args, {
		on_exit = function()
			vim.schedule(reset)
		end,
	})
	if M.job <= 0 then
		M.job = nil
		vim.notify("[ytmusic] failed to start mpv", vim.log.levels.ERROR)
		if cb then
			cb(false)
		end
		return
	end
	connect(cb)
end

function M.quit()
	if M.connected then
		M.send({ "quit" })
	end
	if M.job then
		local job = M.job
		vim.defer_fn(function()
			pcall(vim.fn.jobstop, job)
		end, 200)
	end
end

return M
