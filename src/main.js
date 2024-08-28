import plugin from "../plugin.json";
import FS from '@isomorphic-git/lightning-fs';
import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
const fsOperation = acode.require("fsOperation");
const encodings = acode.require('encodings');

const SYMLINKS_FILE = DATA_STORAGE + '.symlinks.json';

function extname(path) {
  const filename = path.split("/").slice(-1)[0];
  if (/.+\..*$/.test(filename)) {
    return /(?:\.([^.]*))?$/.exec(filename)[0] || "";
  }

  return "";
}

function basename(path, ext = "") {
  ext = ext || "";
  if (path === "" || path === "/") return path;
  const ar = path.split("/");
  const last = ar.slice(-1)[0];
  if (!last) return ar.slice(-2)[0];
  let res = decodeURI(last.split("?")[0] || "");
  if (extname(res) === ext) res = res.replace(new RegExp(ext + "$"), "");
  return res;
}

function dirname(path) {
  if (path.endsWith("/")) path = path.slice(0, -1);
  const parts = path.split("/").slice(0, -1);
  if (!/^(\.|\.\.|)$/.test(parts[0])) parts.unshift(".");
  const res = parts.join("/");

  if (!res) return "/";
  else return res.replace(/^\.\/?/, '');
}

function convertToStatLike(cordovaStat) {
  const statLike = {
    type: cordovaStat.isFile ? 'file' : cordovaStat.isDirectory ? 'dir' : 'symlink',
    mode: cordovaStat.isFile ? 0o644 : cordovaStat.isDirectory ? 0o755 : 0o120000, // Use default modes, can be customized
    size: cordovaStat.length,
    ino: generateIno(cordovaStat.url), // You can use a function to generate a unique inode
    mtimeMs: cordovaStat.lastModified, // Assuming modifiedDate is in milliseconds
    ctimeMs: cordovaStat.lastModified, // Optionally add creation time
  };
  return statLike;
}
function generateIno(url) {
  return url.hashCode();
}

function fixFileUrl(url) {
  if (url.startsWith('file:/') && !url.startsWith('file:///')) {
    return url.replace('file:/', 'file:///');
  }
  return url;
}



function Err(name) {
  return class extends Error {
    constructor(...args) {
      super(...args);
      this.code = name;
      if (this.message) {
        this.message = name + ": " + this.message;
      } else {
        this.message = name;
      }
    }
  };
}

const EEXIST = Err("EEXIST");
const ENOENT = Err("ENOENT");
const ENOTDIR = Err("ENOTDIR");
const ENOTEMPTY = Err("ENOTEMPTY");
const ETIMEDOUT = Err("ETIMEDOUT");
const EISDIR = Err("EISDIR");

class FsBackend {
  constructor() {
    this.symlinkStore = {};
    this._loadSymlinks();
  }
  async _loadSymlinks() {
    // Load the symlink store from the symlink file
    try {
      const exists = await fsOperation(SYMLINKS_FILE).exists();
      if (exists) {
        const data = await fsOperation(SYMLINKS_FILE).readFile('utf8');
        this.symlinkStore = JSON.parse(data);
      }
    } catch (err) {
      console.error('Error loading symlink store:', err);
      this.symlinkStore = {};
    }
  }
  async _saveSymlinks() {
    // Save the symlink store to the symlink file
    try {
      const data = JSON.stringify(this.symlinkStore, null, 2);
      if (await fsOperation(SYMLINKS_FILE).exists()) {
        await fsOperation(SYMLINKS_FILE).writeFile(data);
      } else {
        await fsOperation(window.DATA_STORAGE).createFile('.symlinks.json', data);
      }
    } catch (err) {
      console.error('Error saving symlink store:', err);
    }
  }
  saveSuperblock(superblock) { }
  loadSuperblock() { }

  async mkdir(filepath, opts = { recursive: false, mode: 0o777 }) {
    try {
      // Normalize the filepath
      filepath = fixFileUrl(filepath);
      const dir = dirname(filepath)
      const dirName = basename(filepath);
      console.info("fs - mkdir, path: ", filepath)

      // Check if the directory already exists
      if (await fsOperation(filepath).exists()) {
        throw new EEXIST(filepath);
      }

      // Handle recursive directory creation
      if (opts.recursive) {
        // Create parent directories if necessary
        const parentDir = dirname(filepath);
        if (parentDir && parentDir !== filepath) {
          // Check if the parent directory exists
          if (!(await fsOperation(parentDir).exists())) {
            // Recursively create parent directories
            await this.mkdir(parentDir, { recursive: true, mode: opts.mode });
          }
        }
      } else {
        // If not recursive, ensure the parent directory exists
        const parentDir = dirname(filepath);
        if (!(await fsOperation(parentDir).exists())) {
          throw new ENOENT(parentDir);
        }
      }
      // Finally, create the directory
      await fsOperation(dir).createDirectory(dirName);
    } catch (e) {
      console.error("Error in mkdir:", e);
      throw e;
    }
  }


  async rmdir(filepath, opts) {
    try {
      filepath = fixFileUrl(filepath)
      console.info("fs - rmdir, path: ", filepath)
      let stats = await fsOperation(filepath).stat();
      if (!stats.isDirectory) throw new ENOTDIR();
      let dirContents = await fsOperation(filepath).lsDir();
      if (dirContents.length > 0) {
        throw new ENOTEMPTY();
      }
      if (!await fsOperation(filepath).exists()) {
        throw new ENOENT(filepath);
      }
      await fsOperation(filepath).delete();
    } catch (e) {
      console.error("error in rmdir : ", e)
      throw e;
    }
  }

  async readdir(filepath, opts = {}) {
    try {
      filepath = fixFileUrl(filepath);
      console.info("fs - readdir, path: ", filepath)
      if (!(await fsOperation(filepath).exists())) {
        throw new ENOENT(filepath);
      }
      let stats = await fsOperation(filepath).stat();
      if (!stats.isDirectory) {
        throw new ENOTDIR();
      }
      const dirContents = await fsOperation(filepath).lsDir();
      return dirContents.map(item => item.name);
    } catch (e) {
      console.error("Error in readdir:", e);
      throw e;
    }
  }


  async readFile(filepath, opts = {}) {
    try {
      if (!filepath) return;
      filepath = fixFileUrl(filepath);
      console.info("fs - readFile, path:", filepath);
      const encoding = opts.encoding || 'utf8';
      if (encoding !== 'utf8') {
        throw new Error('Only "utf8" encoding is supported');
      }
      if (!await fsOperation(filepath).exists()) {
        throw new ENOENT(filepath);
      }
      let content = await fsOperation(filepath).readFile('utf8');
      if (!opts.encoding) {
        return await encodings.encode(content, 'utf8')
      }
      return content;
    } catch (e) {
      console.error("error in readFile:", e);
      throw e;
    }
  }


  async writeFile(filepath, data, opts = { encoding: 'utf8', flag: 'w' }) {
    try {
      filepath = fixFileUrl(filepath);
      console.info("fs - writeFile, path: ", filepath)
      const { encoding = 'utf8', flag = 'w' } = opts;

      if (!(await fsOperation(dirname(filepath)).exists())) {
        throw new ENOENT(dirname(filepath));
      }

      if (flag === 'w') {
        try {
          await fsOperation(filepath).writeFile(data);
        } catch (e) {
          let fileName = basename(filepath);
          let dir = dirname(filepath);
          await fsOperation(dir).createFile(fileName, data);
        }
      } else if (flag === 'a') {
        try {
          let existingData = await fsOperation(filepath).readFile('utf8');
          let newData = existingData + data;
          await fsOperation(filepath).writeFile(newData);
        } catch (e) {
          let fileName = basename(filepath);
          let dir = dirname(filepath);
          await fsOperation(dir).createFile(fileName, data);
        }
      }
    } catch (e) {
      console.error("error in writeFile : ", e)
      throw e;
    }
  }

  async unlink(filepath, opts) {
    try {
      filepath = fixFileUrl(filepath)
      console.info("fs - unlink, path: ", filepath)
      if (!await fsOperation(filepath).exists()) {
        throw new ENOENT(filepath);
      }
      await fsOperation(filepath).delete();
      if (this.symlinkStore[filepath]) {
        delete this.symlinkStore[filepath];
        await this._saveSymlinks();  // Update the symlink file
      }
    } catch (e) {
      console.error("error in unlink : ", e)
      throw e;
    }
  }

  async rename(oldFilepath, newFilepath) {
    try {
      oldFilepath = fixFileUrl(oldFilepath)
      newFilepath = fixFileUrl(newFilepath)
      console.log("rename: ", filepath)
      if (!await fsOperation(oldFilepath).exists()) {
        throw new ENOENT(oldFilepath);
      }
      await fsOperation(oldFilepath).renameTo(basename(newFilepath));
      // Handle renaming symlinks
      if (this.symlinkStore[oldFilepath]) {
        this.symlinkStore[newFilepath] = this.symlinkStore[oldFilepath];
        delete this.symlinkStore[oldFilepath];
        await this._saveSymlinks();
      }
    } catch (e) {
      console.error("error in rename : ", e)
      throw e;
    }
  }

  async stat(filepath) {
    try {
      if (filepath === "/") return { type: "dir", mode: 0o755 };
      filepath = fixFileUrl(filepath)
      console.info("fs - stat, path: ", filepath)
      if (!await fsOperation(filepath).exists()) {
        throw new ENOENT(filepath);
      }
      return convertToStatLike(await fsOperation(filepath).stat());
    } catch (e) {
      console.error("error in stat : ", e)
      throw e;
    }
  }

  async lstat(filepath) {
    try {
      filepath = fixFileUrl(filepath)
      console.info("fs - lstat, path: ", filepath)
      if (!await fsOperation(filepath).exists()) {
        throw new ENOENT(filepath);
      }
      // Check if the filepath is a symbolic link
      if (this.symlinkStore[filepath]) {
        let fileStat = await fsOperation(filepath).stat();
        // Return the symbolic link's metadata, not the target's metadata
        return convertToStatLike({
          name: fileStat.name,
          url: filepath,
          isFile: false,
          isDirectory: false,
          isLink: true,
          size: 0,
          modifiedDate: fileStat.modifiedDate,
          canRead: true,
          canWrite: true,
        });
      }

      // If it's not a symlink, return the regular file/directory stats
      return convertToStatLike(await fsOperation(filepath).stat());
    } catch (e) {
      console.error("error in lstat : ", e)
      throw e;
    }
  }


  async symlink(target, filepath) {
    try {
      filepath = fixFileUrl(filepath)
      console.info("fs - symlink, path: " + filepath + " target: ", target);
      this.symlinkStore[filepath] = target;
      await this._saveSymlinks();  // Save to the symlink file
      await this.writeFile(filepath, 'SYMLINK_PLACEHOLDER');
    } catch (e) {
      console.error("error in symlink : ", e)
      throw e;
    }
  }

  async readlink(filepath) {
    try {
      filepath = fixFileUrl(filepath)
      console.info("fs - readlink, path: ", filepath)
      if (!await fsOperation(filepath).exists()) {
        throw new ENOENT(filepath);
      }
      return this.symlinkStore[filepath];
    } catch (e) {
      console.error("error in readlink : ", e)
      throw e;
    }
  }
}

class Git {
  constructor() {
    const customBackend = new FsBackend();
    this.fs = new FS("myfs", { backend: customBackend });
  }
  async init() {
    editorManager.editor.commands.addCommand({
      name: "clone repo",
      exec: this.cloneRepo.bind(this)
    });
    editorManager.editor.commands.addCommand({
      name: "git actions",
      exec: this.gitActions.bind(this)
    });
  }

  async cloneRepo() {
    try {
      const prompt = acode.require("prompt");
      const gitUrl = await prompt("Enter the git url", "https://github.com/isomorphic-git/lightning-fs", "text");
      if (!gitUrl) return;
      if (!await fsOperation(window.DATA_STORAGE + "test").exists()) {
        await this.fs.promises.mkdir(window.DATA_STORAGE + "test");
      }
      await git.clone({
        fs: this.fs.promises,
        http,
        dir: window.DATA_STORAGE + "test",
        corsProxy: 'https://cors.isomorphic-git.org',
        url: 'https://github.com/isomorphic-git/lightning-fs',
        depth: 1,
        onMessage: console.log
      })
      console.log('done')
    } catch (e) {
      console.log("Error cloning: ", e)
    }
  }

  async gitActions() {
    try {
      const select = acode.require("select");
      let action = await select("Git action", ["init", "add", "commit","log"]);
      switch (action) {
        case "init":
          await git.init({
            fs: this.fs.promises,
            http,
            dir: window.DATA_STORAGE + "test",
          });
          console.log("done init👍 ")
          break;
        case "add":
          await fsOperation(window.DATA_STORAGE + "test").createFile("test.txt", "hello");
          await git.add({ fs: this.fs.promises, dir: window.DATA_STORAGE + "test", filepath: 'test.txt' })
          console.log("done adding ")
          break;
        case "commit":
          let sha = await git.commit({
            fs: this.fs.promises,
            dir: window.DATA_STORAGE + "test",
            author: {
              name: 'Mr. Test',
              email: 'mrtest@example.com',
            },
            message: 'Added the test.txt file'
          })
          console.log("commited", sha)
          break;
        case "log":
          let commits = await git.log({
            fs: this.fs.promises,
            dir: window.DATA_STORAGE + "test",
            depth: 5,
          })
          console.log("logs", commits)

          break;
      }
    } catch (e) {
      console.log("error in git action: ", e)
    }
  }

  async destroy() {
    editorManager.editor.commands.removeCommand('clone repo');
    editorManager.editor.commands.removeCommand('git actions');
  }
}

if (window.acode) {
  const acodePlugin = new Git();
  acode.setPluginInit(
    plugin.id,
    (baseUrl, $page, { cacheFileUrl, cacheFile }) => {
      if (!baseUrl.endsWith("/")) {
        baseUrl += "/";
      }
      acodePlugin.baseUrl = baseUrl;
      acodePlugin.init($page, cacheFile, cacheFileUrl);
    }
  );
  acode.setPluginUnmount(plugin.id, () => {
    acodePlugin.destroy();
  });
}
