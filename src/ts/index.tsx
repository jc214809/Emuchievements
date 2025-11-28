import {
  afterPatch,
  beforePatch,
  callOriginal,
  definePlugin,
  findModuleChild,
  replacePatch,
  Router,
  ServerAPI,
  staticClasses,
} from "decky-frontend-lib";

import { FaClipboardCheck } from "react-icons/fa";
import { SettingsComponent } from "./components/settingsComponent";
import { EmuchievementsComponent } from "./components/emuchievementsComponent";
import {
  EmuchievementsState,
  EmuchievementsStateContextProvider,
} from "./hooks/achievementsContext";
import Logger from "./logger";

import {
  AppDetailsStore,
  AppStore,
  CollectionStore,
  SteamAppAchievement,
  SteamAppOverview,
} from "./SteamTypes";

import { checkOnlineStatus, waitForOnline } from "./steam-utils";
import { EventBus, MountManager } from "./System";
import { patchAppPage } from "./RoutePatches";
import { runInAction } from "mobx";
import { getTranslateFunc } from "./useTranslations";
import { GameListComponent } from "./components/gameListComponent";
import { StoreCategory } from "./AchievementsManager";

declare global {
  let SteamClient: SteamClient;
  let appStore: AppStore;
  let appDetailsStore: AppDetailsStore;

  let appDetailsCache: any;

  let appAchievementProgressCache: {
    m_achievementProgress: {
      nVersion: number;
      mapCache: Map<
        number,
        {
          all_unlocked: boolean;
          appid: number;
          cache_time: number;
          percentage: number;
          total: number;
          unlocked: number;
        }
      >;
    };
    RequestCacheUpdate(): Promise<void>;
    LoadCacheFile(): Promise<void>;
    SaveCacheFile(): Promise<void>;
  };

  let collectionStore: CollectionStore;
}

// ---------------------------------------------------------------------------
// SAFE FIBER UTILITIES (Decky Loader 4.3+)
// ---------------------------------------------------------------------------

function getSafeProps(node: any) {
  return node?.memoizedProps || node?.pendingProps || null;
}

function safeFiberSearch(node: any, matchFn: (n: any) => boolean): any {
  if (!node) return null;

  try {
    if (matchFn(node)) return node;
  } catch {}

  const child = node.child || node._child;
  const sibling = node.sibling || node._sibling;

  return safeFiberSearch(child, matchFn) || safeFiberSearch(sibling, matchFn);
}

function findChildInParent(parent: any) {
  if (!parent) return null;

  return safeFiberSearch(parent, (fiber) => {
    const props = getSafeProps(fiber);
    return (
      props &&
      (props.className?.includes("GamePadUI") ||
        props.id === "gamepadui" ||
        props["data-testid"] === "game-pad-ui")
    );
  });
}

// ---------------------------------------------------------------------------
// MODULE LOCATORS
// ---------------------------------------------------------------------------

const AppDetailsSections = findModuleChild((m) => {
  if (typeof m !== "object") return;
  for (const prop in m) {
    if (
      typeof m[prop] === "function" &&
      m[prop].toString().includes("m_setSectionsMemo")
    ) {
      return m[prop];
    }
  }
  return;
});

const Achievements = findModuleChild((module) => {
  if (typeof module !== "object") return undefined;
  for (let prop in module) {
    if (module[prop]?.m_mapMyAchievements) return module[prop];
  }
});

// ---------------------------------------------------------------------------
// MAIN PLUGIN
// ---------------------------------------------------------------------------

interface Hook {
  unregister(): void;
}

export default definePlugin(function (serverAPI: ServerAPI) {
  const t = getTranslateFunc();
  const logger = new Logger("Index");
  const state = new EmuchievementsState(serverAPI);
  let lifetimeHook: Hook;

  const eventBus = new EventBus();
  const mountManager = new MountManager(eventBus, logger, serverAPI);

  mountManager.addPageMount("/emuchievements/settings", () => (
    <EmuchievementsStateContextProvider emuchievementsState={state}>
      <SettingsComponent />
    </EmuchievementsStateContextProvider>
  ));

  mountManager.addPageMount("/emuchievements/achievements", () => (
    <EmuchievementsStateContextProvider emuchievementsState={state}>
      <GameListComponent />
    </EmuchievementsStateContextProvider>
  ));

  // -------------------------------------------------------------------------
  // LoadMyAchievements patch
  // -------------------------------------------------------------------------

  mountManager.addPatchMount({
    patch(): any {
      return replacePatch(
        Achievements.__proto__,
        "LoadMyAchievements",
        (args) => {
          if (
            appStore.GetAppOverviewByAppID(args[0])?.app_type ===
              1073741824 &&
            !Achievements.m_mapGlobalAchievements.has(args[0])
          ) {
            let data = state.managers.achievementManager.fetchAchievements(
              args[0]
            );

            if (!data.global.loading)
              Achievements.m_mapGlobalAchievements.set(args[0], data.global);
            if (!data.user.loading)
              Achievements.m_mapMyAchievements.set(args[0], data.user);
            return;
          }
          return callOriginal;
        }
      );
    },
  });

  // -------------------------------------------------------------------------
  // Store Category patch
  // -------------------------------------------------------------------------

  mountManager.addPatchMount({
    patch(): any {
      return replacePatch(
        appStore.allApps[0].__proto__,
        "BHasStoreCategory",
        function (args) {
          if ((this as SteamAppOverview).app_type === 1073741824) {
            if (
              state.settings.general.store_category &&
              state.managers.achievementManager.isReady(
                (this as SteamAppOverview).appid
              ) &&
              args[0] === StoreCategory.Achievements
            ) {
              return true;
            }
          }
          return callOriginal;
        }
      );
    },
  });

  // -------------------------------------------------------------------------
  // Achievement injection
  // -------------------------------------------------------------------------

  function setAchievements(appid: number) {
    let appData = appDetailsStore.GetAppData(appid);
    if (
      appData &&
      !appData.bLoadingAchievments &&
      appData.details.achievements.nTotal === 0
    ) {
      appData.bLoadingAchievments = true;
      const achievements = state.managers.achievementManager.fetchAchievements(
        appid
      );

      if (achievements.user.data) {
        const nAchieved = Object.keys(achievements.user.data.achieved).length;
        const nTotal =
          Object.keys(achievements.user.data.achieved).length +
          Object.keys(achievements.user.data.unachieved).length;

        const vecHighlight: SteamAppAchievement[] = [];
        Object.values(achievements.user.data.achieved).forEach((value) =>
          vecHighlight.push(value)
        );

        const vecUnachieved: SteamAppAchievement[] = [];
        Object.values(achievements.user.data.unachieved).forEach((value) =>
          vecUnachieved.push(value)
        );

        runInAction(() => {
          appData.details.achievements = {
            nAchieved,
            nTotal,
            vecAchievedHidden: [],
            vecHighlight,
            vecUnachieved,
          };
          appDetailsCache.SetCachedDataForApp(
            appid,
            "achievements",
            2,
            appData.details.achievements
          );
        });
      }

      appData.bLoadingAchievments = false;
    }
  }

  // -------------------------------------------------------------------------
  // Patches for GetAchievements
  // -------------------------------------------------------------------------

  mountManager.addPatchMount({
    patch(): any {
      return beforePatch(appDetailsStore, "GetAchievements", (args) => {
        if (state.managers.achievementManager.isReady(args[0])) {
          setAchievements(args[0]);
        }
      });
    },
  });

  // -------------------------------------------------------------------------
  // Patch: Remote Play Together
  // -------------------------------------------------------------------------

  mountManager.addPatchMount({
    patch(): any {
      return beforePatch(
        Router,
        "BIsStreamingRemotePlayTogetherGame",
        () => {
          const appid =
            (Router.MainRunningApp as SteamAppOverview | undefined)?.appid ??
            0;

          if (state.managers.achievementManager.isReady(appid)) {
            setAchievements(appid);
          }
        }
      );
    },
  });

  // -------------------------------------------------------------------------
  // PATCH AppDetailsSections render (THIS WAS THE CRASHING AREA)
  // -------------------------------------------------------------------------

  mountManager.addPatchMount({
    patch(): any {
      return afterPatch(
        AppDetailsSections.prototype,
        "render",
        (_args, component) => {
          const safeProps = getSafeProps(component?._owner);
          const overview: SteamAppOverview = safeProps?.overview;

          if (!overview) return component;

          logger.debug("Safe overview props", safeProps);

          if (overview.app_type === 1073741824) {
            if (state.managers.achievementManager.isReady(overview.appid)) {
              afterPatch(
                component._owner.type.prototype,
                "GetSections",
                (_x, ret: Set<string>) => {
                  if (
                    state.settings.general.game_page &&
                    state.managers.achievementManager.isReady(overview.appid)
                  )
                    ret.add("achievements");
                  else ret.delete("achievements");

                  logger.debug(`${overview.appid} Sections: `, ret);
                  return ret;
                }
              );
            }
          }
          return component;
        }
      );
    },
  });

  // -------------------------------------------------------------------------
  // Lifetime notifications
  // -------------------------------------------------------------------------

  mountManager.addMount({
    mount: function () {
      lifetimeHook =
        SteamClient.GameSessions.RegisterForAppLifetimeNotifications(
          (update: { unAppID: number; nInstanceID: number; bRunning: boolean }) => {
            logger.debug("lifetime", update);

            const overview = appStore.GetAppOverviewByAppID(
              update.unAppID
            ) as SteamAppOverview;

            if (overview.app_type == 1073741824) {
              if (!update.bRunning) {
                state.managers.achievementManager.clearRuntimeCacheForAppId(
                  update.unAppID
                );
                state.managers.achievementManager.fetchAchievements(
                  update.unAppID
                );
              }
            }
          }
        );
    },
    unMount: function () {
      lifetimeHook?.unregister();
    },
  });

  mountManager.addMount(patchAppPage(state));

  mountManager.addMount({
    mount: async function () {
      if (await checkOnlineStatus(serverAPI)) {
        await state.init();
      } else {
        await waitForOnline(serverAPI);
        await state.init();
      }
    },
    unMount: async function () {
      await state.deinit();
    },
  });

  const unregister = mountManager.register();

  return {
    title: <div className={staticClasses.Title}>{t("title")}</div>,
    content: (
      <EmuchievementsStateContextProvider emuchievementsState={state}>
        <EmuchievementsComponent />
      </EmuchievementsStateContextProvider>
    ),
    icon: <FaClipboardCheck />,
    onDismount() {
      serverAPI.routerHook.removeRoute("/emuchievements/settings");
      unregister();
    },
  };
});
