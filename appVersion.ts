// ACT: 各端共用版本号，Web、Server 和移动端不依赖桌面 SDK 的生成声明。
export const appVersion = process.env.appVersion ?? "2.0.0";
