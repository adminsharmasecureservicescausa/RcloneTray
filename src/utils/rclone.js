/**
 * @typedef {{
 * 		level: 'error' | 'warning' | 'debug' | 'info',
 * 		msg: string,
 * 		source: string,
 * 		time: string,
 * }} LogMessage
 *
 * @typedef {{
 * 		abort: () => void,
 * 		result: Promise<object>
 * }} RemoteCommandResult
 *
 * @typedef {{
 * 		auth: string,
 * 		uri: string
 * }} RemoteCommandServerInfo
 */

import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { devNull } from 'node:os';
import { platform } from 'node:process';
import { existsSync, lstatSync } from 'node:fs';
import semver from 'semver';
import fetch from 'node-fetch';

export const platformBinaryName = platform === 'win32' ? 'rclone.exe' : 'rclone';

export function getRcloneBinary(path) {
	if (!existsSync(path)) {
		throw Error('Path: ' + path + ' does not exist');
	}

	if (lstatSync(path).isDirectory()) {
		return join(path, platform === 'win32' ? 'rclone.exe' : 'rclone');
	}

	return path;
}

/**
 * @param {{
 *  binaryPath?: string,
 *  configFile?: string,
 * }} _
 */
export function rcloneDriver({ binaryPath, configFile }) {
	const binary = !binaryPath ? platformBinaryName : getRcloneBinary(binaryPath);

	return {
		getBinary,
		getVersion,
		versionGte,
		getConfigFile,
		getDefaultConfigFile,
		getCommand,
		command,
		commandAsync,
		rcd,
	};

	/**
	 * @returns {string}
	 */
	function getBinary() {
		return binary;
	}

	/**
	 * @returns {string}
	 * @throws {Error}
	 */
	function getVersion() {
		try {
			const result = spawnSync(binary, ['version'], {
				env: {
					RCLONE_CONFIG: devNull,
				},
			});

			if (result.output) {
				const ver = result.output.toString().trim().split(/\r?\n/).shift().split(/\s+/).pop();
				return semver.clean(ver);
			}
		} catch {}

		throw new Error('Cannot detect Rclone version.');
	}

	/**
	 * @param {string} minVersion
	 * @returns {boolean}
	 */
	function versionGte(minVersion) {
		return semver.gte(getVersion(), minVersion);
	}

	/**
	 * @returns {string}
	 */
	function getConfigFile() {
		if (configFile) {
			return configFile;
		}

		return getDefaultConfigFile();
	}

	/**
	 * @returns {string}
	 */
	function getDefaultConfigFile() {
		try {
			const result = spawnSync(binary, ['config', 'file']);
			if (result.output) {
				return (result.output.toString().trim().split('\n')[1] || '').trim();
			}
		} catch {}

		throw new Error('Cannot detect default Rclone file.');
	}

	/**
	 * @param {string[]} args
	 * @return {[string,string[]]}
	 */
	function getCommand(...args) {
		return [binary, args];
	}

	/**
	 * @param {string[]} args
	 * @param {import('child_process').SpawnOptions=} spawnOptions
	 * @return {import('child_process').SpawnSyncReturns}
	 */
	function command(args, spawnOptions) {
		return spawnSync(...getCommand(...args), spawnOptions);
	}

	/**
	 * @param {string[]} args
	 * @param {import('child_process').SpawnOptions=} spawnOptions
	 * @return {import('child_process').ChildProcess}
	 */
	function commandAsync(args, spawnOptions) {
		return spawn(...getCommand(...args), spawnOptions);
	}

	/**
	 * @param {NodeJS.ProcessEnv=} env
	 * @returns {import('node:child_process').ChildProcess}
	 */
	function rcd(env) {
		const proc = spawn(binary, ['rcd'], {
			detached: false,
			shell: false,
			windowsHide: true,
			stdio: 'pipe',
			env: {
				RCLONE_AUTO_CONFIRM: 'false',
				RCLONE_CONFIG: getConfigFile(),
				RCLONE_PASSWORD: 'false',
				RCLONE_RC_SERVER_WRITE_TIMEOUT: '8760h0m0s',
				RCLONE_RC_SERVER_READ_TIMEOUT: '8760h0m0s',
				RCLONE_RC_WEB_GUI: 'false',
				RCLONE_RC_NO_AUTH: 'false',
				RCLONE_LOG_FORMAT: '',
				RCLONE_LOG_LEVEL: 'NOTICE',
				...(env || {}),
				RCLONE_USE_JSON_LOG: 'true',
			},
		});

		const emitReady = (/** @type {LogMessage} */ data) => {
			if (data.source.startsWith('rcserver/rcserver.go') && data.msg.startsWith('Serving remote control')) {
				proc.off('data', emitReady);
				proc.emit('ready', data.msg.slice(26));
			} else if (data.msg.includes('Failed to start remote control:')) {
				proc.emit('error', data.msg);
				proc.kill(1);
			}
		};

		const jsonLogEmmit = (/** @type {string} */ text) => proc.emit('data', rcdJsonParser(text));

		streamReadlineHandler(proc.stdout, jsonLogEmmit);
		streamReadlineHandler(proc.stderr, jsonLogEmmit);

		proc.on('data', emitReady);

		return proc;
	}
}

/**
 * Perform RC command
 * @param {RemoteCommandServerInfo} server
 * @param {string} endpoint
 * @param {object=} payload
 * @returns {RemoteCommandResult}
 */
export function remoteCommand(server, endpoint, payload) {
	// eslint-disable-next-line no-undef
	const abortController = new AbortController();
	const uri = server.uri + endpoint;
	const authHeader = server.auth ? 'Basic ' + Buffer.from(server.auth).toString('base64') : null;

	return {
		abort,
		result: result(),
	};

	function abort() {
		abortController.abort();
	}

	async function result() {
		const fetcher = await fetch(uri, {
			method: 'POST',
			signal: abortController.signal,
			headers: {
				Authorization: authHeader,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload || {}),
		});

		return fetcher.json();
	}
}

/**
 * @param {string} text
 * @returns {object}
 */
function rcdJsonParser(text) {
	try {
		return JSON.parse(text);
	} catch {
		return {
			level: 'error',
			source: '',
			time: new Date().toJSON(),
			msg: text,
		};
	}
}

/**
 * @param {import('stream').Readable} stream
 * @param {(text: string) => void} callback
 */
function streamReadlineHandler(stream, callback) {
	let backlog = '';

	stream.on('data', (data) => {
		backlog += data;
		let n = backlog.indexOf('\n');
		while (~n) {
			callback(backlog.slice(0, n));
			backlog = backlog.slice(n + 1);
			n = backlog.indexOf('\n');
		}
	});

	stream.on('end', () => {
		if (backlog) {
			callback(backlog);
		}
	});
}
