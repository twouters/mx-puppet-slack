// taken largely from https://github.com/matrix-hacks/matrix-puppet-slack/blob/master/client.js
import { Log, Util, Lock } from "mx-puppet-bridge";
import { RTMClient } from "@slack/rtm-api";
import { WebClient } from "@slack/web-api";
import { EventEmitter } from "events";

const log = new Log("SlackPuppet:client");

// tslint:disable-next-line:no-magic-numbers
const FETCH_LOCK_TIMEOUT = 1000 * 60;

interface ILock {
	id: number;
	timer: number;
}

interface ILocks {
	[id: number]: ILock;
}

interface IClientData {
	[id: string]: any;
}

export class Client extends EventEmitter {
	private rtm: RTMClient;
	private web: WebClient;
	private data: IClientData = {};
	private lock: Lock<string>;
	private typingUsers: {[key: string]: any};
	constructor(
		private token: string,
	) {
		super();
		this.rtm = new RTMClient(this.token);
		this.web = new WebClient(this.token);
		this.data.channels = [];
		this.data.users = [];
		this.data.bots = [];
		this.typingUsers = {};
		this.lock = new Lock(FETCH_LOCK_TIMEOUT);
	}

	public async disconnect(): Promise<void> {
		await this.rtm.disconnect();
	}

	public async connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			// we couldn't start up successfully, reject this.
			this.rtm.once("unable_to_rtm_start", (err) => {
				this.emit("unable-to-start", err);
				reject(err);
			});

			// disconnect is called only when there is on chance of reconnection,
			// either due to unrecoverable errors or the disabling of reconnect
			// so it's the best way to know to act towards reconnecting
			// the issue here is that at this point we dont know if
			// its an "unrecoverable error" or not, so if we were to implement
			// reconnect ourself in respones to this event, we may start looping
			this.rtm.on("disconnected", () => {
				this.emit("disconnected"); // can use this to announce status and issue a reconnect
			});

			this.rtm.on("authenticated", (rtmStartData) => {
				log.verbose(`Logged in as ${rtmStartData.self.name} of team ${rtmStartData.team.name}`);
				this.data.self = rtmStartData.self;
				this.emit("authenticated", rtmStartData);
			});

			this.rtm.on("ready", async () => {
				this.emit("connected");
				resolve();
				const users = (await this.web.users.list()) as any;
				if (users && users.members) {
					const usersArr: string[] = [];
					for (const u of users.members) {
						usersArr.push(u.id);
					}
					await this.rtm.subscribePresence(usersArr);
				}
			});

			this.rtm.on("message", (data) => {
				const key = `${data.user || data.bot_id};${data.channel}`;
				if (this.typingUsers[key]) {
					this.emit("typing", this.typingUsers[key], true);
					delete this.typingUsers[key];
				}
				this.emit("message", data);
			});

			this.rtm.on("reaction_added", (data) => {
				this.emit("reaction_added", data);
			});

			for (const ev of ["channel_joined", "group_joined", "mpim_joined", "im_created"]) {
				this.rtm.on(ev, async (data) => {
					const chan = await this.getChannelById(data.channel.id);
					if (!chan) {
						this.data.channels.push(data.channel);
						this.emit("addChannel", data.channel);
					}
				});
			}

			for (const ev of ["channel_rename", "group_rename"]) {
				this.rtm.on(ev, (data) => {
					this.updateChannel(data.channel);
				});
			}

			this.rtm.on("team_join", async (data) => {
				this.data.users.push(data.user);
				this.emit("addUser", data.user);
				await this.rtm.subscribePresence([data.user.id]);
			});

			this.rtm.on("user_change", (data) => {
				this.updateUser(data.user);
			});

			this.rtm.on("user_typing", (data) => {
				this.emit("typing", data, true);
				const key = `${data.user || data.bot_id};${data.channel}`;
				if (!this.typingUsers[key]) {
					this.typingUsers[key] = data;
				}
			});

			this.rtm.on("presence_change", (data) => {
				log.silly(data);
				this.emit("presence", data);
			});

			for (const ev of ["bot_added", "bot_changed"]) {
				this.rtm.on(ev, (data) => {
					this.updateBot(data.bot);
				});
			}

			// this is floating as we resolve the new promise in a callback
			// tslint:disable-next-line:no-floating-promises
			this.rtm.start();
		});
	}

	public getSelfUserId() {
		return this.data.self.id;
	}

	public async getBotById(id: string): Promise<any> {
		const bot = this.data.bots.find((u) => (u.id === id || u.name === id));
		if (bot) {
			return bot;
		}
		const lockKey = `bot_${id}`;
		await this.lock.wait(lockKey);
		this.lock.set(lockKey);
		try {
			const ret = await this.web.bots.info({ bot: id });
			this.updateBot(ret.bot);
			this.lock.release(lockKey);
			return ret.bot;
		} catch (err) {
			log.verbose("could not fetch the bot info", err.message);
		}
		this.lock.release(lockKey);
		return { name: "unknown" };
	}

	public async getUserById(id: string): Promise<any> {
		const user = this.data.users.find((u) => (u.id === id || u.name === id));
		if (user) {
			return user;
		}
		const lockKey = `user_${id}`;
		await this.lock.wait(lockKey);
		this.lock.set(lockKey);
		try {
			const ret = await this.web.users.info({ user: id });
			this.updateUser(ret.user);
			this.lock.release(lockKey);
			return ret.user;
		} catch (err) {
			log.verbose("could not fetch the user info", err.message);
		}
		this.lock.release(lockKey);
		return null;
	}

	public async getChannelById(id: string): Promise<any> {
		const chan = await this.getRoomById(id);
		if (!chan || chan.isDirect) {
			return null;
		}
		return chan;
	}

	public async getRoomById(id: string): Promise<any> {
		let chan = this.data.channels.find((c) => (c.id === id || c.name === id));
		if (!chan) {
			const lockKey = `chan_${id}`;
			await this.lock.wait(lockKey);
			this.lock.set(lockKey);
			try {
				const ret = await this.web.conversations.info({ channel: id });
				if (!ret.channel) {
					this.lock.release(lockKey);
					return null;
				}
				this.updateChannel(ret.channel);
				this.lock.release(lockKey);
				chan = ret.channel;
			} catch (err) {
				log.verbose("could not fetch the conversation info", err.message);
				this.lock.release(lockKey);
				return null;
			}
		}
		if (chan.isDirect === undefined) {
			chan.isDirect = !!chan.is_im;
		}
		return chan;
	}

	public async getRoomForUser(id: string): Promise<string | null> {
		const reply = await this.web.users.conversations({
			types: "im",
			user: id,
		}) as any;
		if (!reply.ok) {
			return null;
		}
		if (!reply.channels.length) {
			return null;
		}
		if (!reply.channels[0].is_im) {
			return null;
		}
		return reply.channels[0].id;
	}

	public async listUsers(): Promise<any[]> {
		const users = (await this.web.users.list()) as any;
		if (!users || !users.members) {
			return [];
		}
		return users.members;
	}

	public async listChannels(): Promise<any[]> {
		const reply = await this.web.users.conversations({
			types: "public_channel,private_channel",
			limit: 1000,
		}) as any;
		if (!reply || !reply.ok) {
			return [];
		}
		return reply.channels;
	}

	public async getTeamById(id: string): Promise<any> {
		try {
			// as any, because web api doesn't know of team objects
			return ((await this.web.team.info({ team: id })) as any).team;
		} catch (err) {
			log.verbose("could not fetch the team info", err.message);
			return null;
		}
	}

	public updateUser(user) {
		let found = false;
		for (let i = 0; i < this.data.users.length; i++) {
			if (this.data.users[i].id === user.id) {
				this.data.users[i] = user;
				found = true;
				break;
			}
		}
		if (!found) {
			this.data.users.push(user);
		}
		this.emit("updateUser", user);
	}

	public updateBot(user) {
		let found = false;
		for (let i = 0; i < this.data.bots.length; i++) {
			if (this.data.bots[i].id === user.id) {
				this.data.bots[i] = user;
				found = true;
				break;
			}
		}
		if (!found) {
			this.data.bots.push(user);
		}
		this.emit("updateBot", user);
	}

	public updateChannel(channel) {
		let chan;
		for (const c of this.data.channels) {
			if (c.id === channel.id) {
				chan = c;
				break;
			}
		}
		if (!chan) {
			this.data.channels.push(channel);
			chan = channel;
		}
		if (chan.name !== channel.name) {
			chan.name = channel.name;
		}
		this.emit("updateChannel", channel);
	}

	public async editMessage(text: string, channel: string, ts: string): Promise<string> {
		const ret = await this.web.chat.update({
			text: `\ufff0${text}`,
			channel,
			as_user: true,
			ts,
		});
		return ret.ts as string;
	}

	public async replyMessage(text: string, channel: string, ts: string): Promise<string> {
		const ret = await this.web.chat.postMessage({
			text: `\ufff0${text}`,
			channel,
			as_user: true,
			thread_ts: ts,
		});
		return ret.ts as string;
	}

	public async deleteMessage(channel: string, ts: string) {
		await this.web.chat.delete({
			channel,
			ts,
			as_user: true,
		});
	}

	public async sendMeMessage(text: string, channel: string): Promise<string> {
		const ret = await this.web.chat.meMessage({
			text: `\ufff0${text}`,
			channel,
		});
		return ret.ts as string;
	}

	public async sendMessage(text: string, channel: string): Promise<string> {
		const ret = await this.rtm.sendMessage(text, channel);
		return ret.ts as string;
	}

	public async sendReaction(channel: string, event: string, reaction: string) {
		await this.web.reactions.add({
			channel,
			timestamp: event,
			name: reaction,
		});
	}

	public getUsers(): any {
		return this.data.users;
	}

	public getChannels(): any {
		return this.data.channels;
	}

	public async sendFileMessage(fileUrl: string, title: string, filename: string, channel?: string): Promise<string> {
		if (!channel) {
			// three parameters, meaning title == filename
			channel = filename;
			filename = title;
		}
		const buffer = await Util.DownloadFile(fileUrl);
		const opts = {
			filename,
			file: buffer,
			title: `\ufff0${title}`,
			filetype: "auto",
			channels: channel,
		};
		const ret = await this.web.files.upload(opts);
		return ret.ts as string;
	}

	public async downloadFile(url: string): Promise<Buffer> {
		return await Util.DownloadFile(url, {
			headers: { Authorization: `Bearer ${this.token}` },
		});
	}
}
