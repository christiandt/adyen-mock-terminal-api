// Bundles the desktop app's main process (with the mock terminal's server) into one CommonJS
// file. With --package it builds the installers in release/; with --package --dir only an
// unpacked app for this machine, to try it quickly. The app takes the repository's version
// (package.json at the root), so that stays the only place to change it.
import * as esbuild from 'esbuild'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoDir = join(here, '..')
const { version } = JSON.parse(await readFile(join(repoDir, 'package.json'), 'utf-8'))

await esbuild.build({
	entryPoints: [join(here, 'main.js')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node22',
	outfile: join(here, 'dist', 'main.cjs'),
	external: ['electron'],
	// The server's dependencies resolve from the repository's node_modules.
	nodePaths: [join(repoDir, 'node_modules')],
	logLevel: 'warning',
})
console.log(`Bundled the desktop app (version ${version}).`)

if (process.argv.includes('--package')) {
	const { build, Platform, Arch } = await import('electron-builder')
	await build({
		projectDir: here,
		targets: process.argv.includes('--dir')
			? Platform.current().createTarget('dir', Arch[process.arch])
			: undefined,
		publish: 'never',
		config: {
			appId: 'io.github.christiandt.adyen-mock-terminal',
			productName: 'Adyen Mock Terminal',
			artifactName: 'adyen-mock-terminal-desktop-${version}-${os}-${arch}.${ext}',
			extraMetadata: { version },
			directories: { output: 'release', buildResources: 'build' },
			files: ['dist/**', 'package.json'],
			// The page, payloads and views, read by the server from the app's resources.
			extraResources: [
				{ from: join(repoDir, 'public'), to: 'app-files/public' },
				{ from: join(repoDir, 'src', 'views'), to: 'app-files/src/views' },
			],
			// No auto-update, so no latest*.yml (which electron-builder fails writing for the mac zip).
			publish: null,
			mac: {
				category: 'public.app-category.developer-tools',
				target: [
					{ target: 'dmg', arch: ['arm64', 'x64'] },
					{ target: 'zip', arch: ['arm64', 'x64'] },
				],
				// Not signed with a Developer ID: ad-hoc, so macOS offers to open a downloaded copy
				// rather than calling it damaged. The hardened runtime's library validation would
				// reject ad-hoc signed frameworks.
				identity: '-',
				hardenedRuntime: false,
			},
			win: { target: [{ target: 'nsis', arch: ['x64'] }, { target: 'portable', arch: ['x64'] }] },
			portable: { artifactName: 'adyen-mock-terminal-desktop-${version}-win-portable-${arch}.${ext}' },
			linux: { category: 'Development', target: [{ target: 'AppImage', arch: ['x64'] }] },
		},
	})
}
