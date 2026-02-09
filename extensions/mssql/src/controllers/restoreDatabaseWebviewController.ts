/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";
import VscodeWrapper from "./vscodeWrapper";
import {
    allFileTypes,
    defaultBackupFileTypes,
    https,
    restoreDatabaseHelpLink,
} from "../constants/constants";
import { FileBrowserService } from "../services/fileBrowserService";
import { AzureBlobService } from "../models/contracts/azureBlob";
import { ObjectManagementWebviewController } from "./objectManagementWebviewController";
import {
    DisasterRecoveryAzureFormState,
    ObjectManagementActionParams,
    ObjectManagementActionResult,
    ObjectManagementDialogType,
    ObjectManagementFormItemSpec,
    ObjectManagementWebviewState,
} from "../sharedInterfaces/objectManagement";
import { ObjectManagementService } from "../services/objectManagementService";
import {
    RecoveryState,
    RestoreDatabaseFormState,
    RestoreDatabaseReducers,
    RestoreDatabaseViewModel,
    RestoreInfo,
    RestoreType,
    RestorePlanResponse,
    RestoreResponse,
    RestoreParams,
} from "../sharedInterfaces/restore";
import * as LocConstants from "../constants/locConstants";
import { FormItemOptions, FormItemSpec, FormItemType } from "../sharedInterfaces/form";
import ConnectionManager from "./connectionManager";
import {
    loadAzureComponentHelper,
    reloadAzureComponents,
} from "./sharedDisasterRecoveryAzureHelpers";
import { ApiStatus } from "../sharedInterfaces/webview";
import { MediaDeviceType } from "../sharedInterfaces/backup";
import { TaskExecutionMode } from "../sharedInterfaces/schemaCompare";
import { TreeNodeInfo } from "../objectExplorer/nodes/treeNodeInfo";
import { getErrorMessage } from "../utils/utils";
import { VsCodeAzureHelper } from "../connectionconfig/azureHelpers";
import { BlobItem } from "@azure/storage-blob";
import { registerFileBrowserReducers } from "./fileBrowserUtils";
import { FileBrowserReducers, FileBrowserWebviewState } from "../sharedInterfaces/fileBrowser";
import { ReactWebviewPanelController } from "./reactWebviewPanelController";
import { getCloudProviderSettings } from "../azure/providerSettings";

export class RestoreDatabaseWebviewController extends ObjectManagementWebviewController<
    RestoreDatabaseFormState,
    RestoreDatabaseReducers<RestoreDatabaseFormState>
> {
    public readonly RESTORE_DATABASE_TASK_NAME = "Restore Database";
    constructor(
        context: vscode.ExtensionContext,
        vscodeWrapper: VscodeWrapper,
        objectManagementService: ObjectManagementService,
        private connectionManager: ConnectionManager,
        private fileBrowserService: FileBrowserService,
        private azureBlobService: AzureBlobService,
        private node: TreeNodeInfo,
    ) {
        super(
            context,
            vscodeWrapper,
            objectManagementService,
            ObjectManagementDialogType.RestoreDatabase,
            LocConstants.RestoreDatabase.restoreDatabaseTitle,
            "restoreDatabaseDialog",
            node.sessionId,
            node.connectionProfile.server || "",
        );

        this.start();
    }

    protected async initializeDialog(): Promise<void> {
        let restoreViewModel = new RestoreDatabaseViewModel();
        this.state.viewModel.model = restoreViewModel;
        // Make sure the load state is set
        this.updateState();

        restoreViewModel.serverName = this.serverName;

        // Get restore config info; Gets the recovery model, default backup folder, and encryptors
        const restoreConfigInfo = (
            await this.objectManagementService.getRestoreConfigInfo(this.state.ownerUri)
        ).configInfo;

        // File Browser setup
        this.state.defaultFileBrowserExpandPath = restoreConfigInfo.defaultBackupFolder;
        this.state.fileFilterOptions = [
            {
                displayName: LocConstants.BackupDatabase.backupFileTypes,
                value: defaultBackupFileTypes,
            },
            {
                displayName: LocConstants.BackupDatabase.allFiles,
                value: allFileTypes,
            },
        ];

        this.state.formComponents = this.setFormComponents();

        // Populate options for source database dropdown based on restoreConfigInfo
        this.state.formComponents["sourceDatabaseName"].options =
            restoreConfigInfo.sourceDatabaseNamesWithBackupSets.map((dbName) => ({
                value: dbName,
                displayName: dbName,
            }));
        this.state.formState.sourceDatabaseName =
            restoreConfigInfo.sourceDatabaseNamesWithBackupSets[0];

        // Populate options for target database dropdown based on databases in the server
        const databases = await this.connectionManager.listDatabases(this.connectionUri);
        const targetDatabaseOptions = databases.map((dbName) => ({
            value: dbName,
            displayName: dbName,
        }));
        this.state.formComponents["targetDatabaseName"].options = targetDatabaseOptions;
        this.state.formState.targetDatabaseName = this.state.formState.sourceDatabaseName;
        restoreViewModel.azureComponentStatuses["blob"] = ApiStatus.NotStarted;

        this.state.formState = {
            ...this.state.formState,
            relocateDbFiles: false,
            replaceDatabase: false,
            keepReplication: false,
            setRestrictedUser: false,
            recoveryState: RecoveryState.WithRecovery,
            backupTailLog: false,
            tailLogWithNoRecovery: false,
            closeExistingConnections: false,
            blob: "",
            dataFileFolder: restoreConfigInfo.dataFileFolder,
            logFileFolder: restoreConfigInfo.logFileFolder,
        };

        await this.createRestoreConnectionContext(this.state.formState.sourceDatabaseName);

        this.state.viewModel.model = restoreViewModel;
        try {
            restoreViewModel.restorePlan = await this.getRestorePlan(false);
            restoreViewModel.restorePlanLoadStatus = ApiStatus.Loaded;

            // Set default values in form state based on restore plan defaults
            restoreViewModel = this.handlePlanUpdate(true, restoreViewModel);

            // Set restore form state props dependent on restore plan details
            this.state.formState = {
                ...this.state.formState,
                tailLogBackupFile:
                    restoreViewModel.restorePlan.planDetails.tailLogBackupFile.defaultValue,
                standbyFile: restoreViewModel.restorePlan.planDetails.standbyFile.defaultValue,
            };
        } catch (error) {
            restoreViewModel.restorePlanLoadStatus = ApiStatus.Error;
            restoreViewModel.errorMessage = getErrorMessage(error);
        }

        this.registerRestoreRpcHandlers();
        restoreViewModel.loadState = ApiStatus.Loaded;

        console.log(this.fileBrowserService);
        console.log(this.azureBlobService);

        this.updateState();
    }

    private registerRestoreRpcHandlers() {
        this.registerReducer("formAction", async (state, payload) => {
            // isAction indicates whether the event was triggered by an action button
            if (payload.event.isAction) {
                const component = state.formComponents[payload.event.propertyName];
                if (component && component.actionButtons) {
                    const actionButton = component.actionButtons.find(
                        (b) => b.id === payload.event.value,
                    );
                    if (actionButton?.callback) {
                        await actionButton.callback();
                    }
                }
                const reloadCompsResult = await reloadAzureComponents(
                    state as ObjectManagementWebviewState<DisasterRecoveryAzureFormState>,
                    payload.event.propertyName,
                );
                // Reload necessary dependent components
                state = reloadCompsResult as ObjectManagementWebviewState<RestoreDatabaseFormState>;
            } else {
                // formAction is a normal form item value change; update form state
                (state.formState[
                    payload.event.propertyName
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ] as any) = payload.event.value;

                // If an azure component changed, reload dependent components and revalidate
                if (
                    [
                        "accountId",
                        "tenantId",
                        "subscriptionId",
                        "storageAccountId",
                        "blobContainerId",
                        "blob",
                    ].includes(payload.event.propertyName)
                ) {
                    const reloadCompsResult = await reloadAzureComponents(
                        state as ObjectManagementWebviewState<DisasterRecoveryAzureFormState>,
                        payload.event.propertyName,
                    );
                    // Reload necessary dependent components
                    state =
                        reloadCompsResult as ObjectManagementWebviewState<RestoreDatabaseFormState>;
                }

                // Re-validate the changed component
                const [componentFormError] = await this.validateForm(
                    state.formState,
                    payload.event.propertyName,
                    true,
                );
                if (componentFormError) {
                    state.formErrors.push(payload.event.propertyName);
                } else {
                    state.formErrors = state.formErrors.filter(
                        (formError) => formError !== payload.event.propertyName,
                    );
                }

                // we have to reload the restore plan if the source database change
                if (
                    payload.event.propertyName === "sourceDatabaseName" ||
                    payload.event.propertyName === "blob"
                ) {
                    const restoreViewModel = this.restoreViewModel(state);
                    if (payload.event.propertyName === "blob") {
                        restoreViewModel.restoreUrl = this.getRestoreUrl(
                            state.formState,
                            restoreViewModel,
                        );
                    }
                    restoreViewModel.restorePlanLoadStatus = ApiStatus.Loading;
                    state.viewModel.model = restoreViewModel;
                    this.updateState();

                    restoreViewModel.restorePlan = await this.getRestorePlan(
                        payload.event.propertyName === "blob",
                    );
                    if (payload.event.propertyName === "blob") {
                        state.formState.sourceDatabaseName =
                            restoreViewModel.restorePlan.planDetails.sourceDatabaseName.currentValue;
                        const targetDbName =
                            restoreViewModel.restorePlan.planDetails.targetDatabaseName
                                .currentValue;
                        const targetDbOptions = state.formComponents["targetDatabaseName"].options;
                        if (!targetDbOptions.find((db) => db.value === targetDbName)) {
                            state.formState.targetDatabaseName =
                                restoreViewModel.restorePlan.planDetails.targetDatabaseName.currentValue;
                        }
                    }
                    restoreViewModel.restorePlanLoadStatus = ApiStatus.Loaded;
                    state.viewModel.model = restoreViewModel;
                }
            }
            return state;
        });

        this.registerReducer("loadAzureComponent", async (state, payload) => {
            const restoreViewModel = this.restoreViewModel(state);
            if (
                payload.componentName == "blob" &&
                restoreViewModel.azureComponentStatuses["blob"] === ApiStatus.NotStarted
            ) {
                state = await this.loadBlobComponent(
                    state as ObjectManagementWebviewState<RestoreDatabaseFormState>,
                );

                const viewModel = state.viewModel.model as RestoreDatabaseViewModel;

                viewModel.restorePlanLoadStatus = ApiStatus.Loading;
                viewModel.azureComponentStatuses[payload.componentName] = ApiStatus.Loaded;
                state.viewModel.model = viewModel;
                this.updateState();

                viewModel.restorePlan = await this.getRestorePlan(true);
                state.formState.sourceDatabaseName =
                    viewModel.restorePlan.planDetails.sourceDatabaseName.currentValue;
                const targetDbName =
                    viewModel.restorePlan.planDetails.targetDatabaseName.currentValue;
                const targetDbOptions = state.formComponents["targetDatabaseName"].options;
                if (!targetDbOptions.find((db) => db.value === targetDbName)) {
                    state.formState.targetDatabaseName =
                        viewModel.restorePlan.planDetails.targetDatabaseName.currentValue;
                }
                viewModel.restorePlanLoadStatus = ApiStatus.Loaded;
                state.viewModel.model = viewModel;
                return state;
            } else {
                const loadResult = await loadAzureComponentHelper(
                    state as ObjectManagementWebviewState<DisasterRecoveryAzureFormState>,
                    payload,
                );
                return loadResult as ObjectManagementWebviewState<RestoreDatabaseFormState>;
            }
        });

        this.registerReducer("setRestoreType", async (state, payload) => {
            const restoreViewModel = state.viewModel.model as RestoreDatabaseViewModel;
            restoreViewModel.restoreType = payload.restoreType;
            state.viewModel.model = restoreViewModel;
            return state;
        });

        this.registerReducer("restoreDatabase", async (state, _payload) => {
            await this.restoreHelper(TaskExecutionMode.executeAndScript);
            return state;
        });

        this.registerReducer("openRestoreScript", async (state, _payload) => {
            await this.restoreHelper(TaskExecutionMode.script);
            return state;
        });

        this.registerReducer("removeBackupFile", async (state, payload) => {
            const restoreViewModel = this.restoreViewModel(state);
            restoreViewModel.backupFiles = restoreViewModel.backupFiles.filter(
                (file) => file.filePath !== payload.filePath,
            );
            state.viewModel.model = restoreViewModel;
            return state;
        });

        registerFileBrowserReducers(
            this as ReactWebviewPanelController<FileBrowserWebviewState, FileBrowserReducers, any>,
            this.fileBrowserService,
            defaultBackupFileTypes,
        );

        // Override default file browser submitFilePath reducer
        this.registerReducer("submitFilePath", async (state, payload) => {
            const restoreViewModel = this.restoreViewModel(state);

            if (!payload.propertyName) {
                const paths = restoreViewModel.backupFiles.map((f) => f.filePath);
                if (!paths.includes(payload.selectedPath)) {
                    restoreViewModel.backupFiles.push({
                        filePath: payload.selectedPath,
                        isExisting: true,
                    });
                }

                restoreViewModel.restorePlanLoadStatus = ApiStatus.Loading;
                state.viewModel.model = restoreViewModel;
                this.updateState();

                restoreViewModel.restorePlan = await this.getRestorePlan(true);
                state.formState.sourceDatabaseName =
                    restoreViewModel.restorePlan.planDetails.sourceDatabaseName.currentValue;
                state.formState.targetDatabaseName =
                    restoreViewModel.restorePlan.planDetails.targetDatabaseName.currentValue;
                restoreViewModel.restorePlanLoadStatus = ApiStatus.Loaded;
            } else {
                if (payload.propertyName in state.formState) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (state.formState[payload.propertyName] as any) = payload.selectedPath;
                } else if (payload.propertyName in restoreViewModel) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (restoreViewModel[payload.propertyName] as any) = payload.selectedPath;
                }
            }
            state.viewModel.model = restoreViewModel;
            return state;
        });
    }

    protected get helpLink(): string {
        return restoreDatabaseHelpLink;
    }

    protected async handleScript(
        params: ObjectManagementActionParams["params"],
    ): Promise<ObjectManagementActionResult> {
        const scriptResult = await this.restoreHelper(TaskExecutionMode.script);
        return {
            success: scriptResult.result,
            errorMessage: scriptResult.errorMessage,
        };
    }

    protected async handleSubmit(
        params: ObjectManagementActionParams["params"],
    ): Promise<ObjectManagementActionResult> {
        const restoreResult = await this.restoreHelper(TaskExecutionMode.executeAndScript);
        return {
            success: restoreResult.result,
            errorMessage: restoreResult.errorMessage,
        };
    }

    private restoreViewModel(
        state?: ObjectManagementWebviewState<RestoreDatabaseFormState>,
    ): RestoreDatabaseViewModel {
        const webviewState = state ?? this.state;
        return webviewState.viewModel.model as RestoreDatabaseViewModel;
    }

    //#region Form Helpers
    protected setFormComponents(): Record<
        string,
        FormItemSpec<
            RestoreDatabaseFormState,
            ObjectManagementWebviewState<RestoreDatabaseFormState>,
            ObjectManagementFormItemSpec<RestoreDatabaseFormState>
        >
    > {
        const createFormItem = (
            spec: Partial<ObjectManagementFormItemSpec<RestoreDatabaseFormState>>,
        ): ObjectManagementFormItemSpec<RestoreDatabaseFormState> =>
            ({
                required: false,
                ...spec,
            }) as ObjectManagementFormItemSpec<RestoreDatabaseFormState>;

        return {
            sourceDatabaseName: createFormItem({
                type: FormItemType.Dropdown,
                propertyName: "sourceDatabaseName",
                label: LocConstants.RestoreDatabase.sourceDatabase,
                groupName: RestoreType.Database,
                options: [],
            }),

            targetDatabaseName: createFormItem({
                type: FormItemType.Dropdown,
                propertyName: "targetDatabaseName",
                label: LocConstants.RestoreDatabase.targetDatabase,
                options: [],
            }),

            accountId: createFormItem({
                propertyName: "accountId",
                label: LocConstants.BackupDatabase.azureAccount,
                required: true,
                type: FormItemType.Dropdown,
                options: [],
                placeholder: LocConstants.ConnectionDialog.selectAnAccount,
                actionButtons: [],
                isAdvancedOption: false,
                groupName: RestoreType.Url,
                validate(state, value) {
                    const restoreViewModel = state.viewModel.model as RestoreDatabaseViewModel;
                    const isValid =
                        value !== "" || !(restoreViewModel.restoreType === RestoreType.Url);
                    return {
                        isValid: isValid,
                        validationMessage: isValid
                            ? ""
                            : LocConstants.BackupDatabase.azureAccountIsRequired,
                    };
                },
            }),

            tenantId: createFormItem({
                propertyName: "tenantId",
                label: LocConstants.BackupDatabase.tenant,
                required: true,
                type: FormItemType.Dropdown,
                options: [],
                placeholder: LocConstants.ConnectionDialog.selectATenant,
                groupName: RestoreType.Url,
                validate(state, value) {
                    const restoreViewModel = state.viewModel.model as RestoreDatabaseViewModel;
                    const isValid =
                        value !== "" || !(restoreViewModel.restoreType === RestoreType.Url);
                    return {
                        isValid: isValid,
                        validationMessage: isValid
                            ? ""
                            : LocConstants.BackupDatabase.tenantIsRequired,
                    };
                },
            }),

            subscriptionId: createFormItem({
                propertyName: "subscriptionId",
                label: LocConstants.BackupDatabase.subscription,
                required: true,
                type: FormItemType.SearchableDropdown,
                options: [],
                placeholder: LocConstants.BackupDatabase.selectASubscription,
                groupName: RestoreType.Url,
                validate(state, value) {
                    const restoreViewModel = state.viewModel.model as RestoreDatabaseViewModel;
                    const isValid =
                        value !== "" || !(restoreViewModel.restoreType === RestoreType.Url);
                    return {
                        isValid: isValid,
                        validationMessage: isValid
                            ? ""
                            : LocConstants.BackupDatabase.subscriptionIsRequired,
                    };
                },
            }),

            storageAccountId: createFormItem({
                propertyName: "storageAccountId",
                label: LocConstants.BackupDatabase.storageAccount,
                required: true,
                type: FormItemType.SearchableDropdown,
                options: [],
                placeholder: LocConstants.BackupDatabase.selectAStorageAccount,
                groupName: RestoreType.Url,
                validate(state, value) {
                    const restoreViewModel = state.viewModel.model as RestoreDatabaseViewModel;
                    const isValid =
                        value !== "" || !(restoreViewModel.restoreType === RestoreType.Url);

                    return {
                        isValid: isValid,
                        validationMessage: isValid
                            ? ""
                            : LocConstants.BackupDatabase.storageAccountIsRequired,
                    };
                },
            }),

            blobContainerId: createFormItem({
                propertyName: "blobContainerId",
                label: LocConstants.BackupDatabase.blobContainer,
                required: true,
                type: FormItemType.SearchableDropdown,
                options: [],
                placeholder: LocConstants.BackupDatabase.selectABlobContainer,
                groupName: RestoreType.Url,
                validate(state, value) {
                    const restoreViewModel = state.viewModel.model as RestoreDatabaseViewModel;
                    const isValid =
                        value !== "" || !(restoreViewModel.restoreType === RestoreType.Url);

                    return {
                        isValid: isValid,
                        validationMessage: isValid
                            ? ""
                            : LocConstants.BackupDatabase.blobContainerIsRequired,
                    };
                },
            }),

            blob: createFormItem({
                propertyName: "blob",
                label: LocConstants.RestoreDatabase.blob,
                required: true,
                type: FormItemType.SearchableDropdown,
                options: [],
                placeholder: LocConstants.RestoreDatabase.selectABlob,
                groupName: RestoreType.Url,
                validate(state, value) {
                    const restoreViewModel = state.viewModel.model as RestoreDatabaseViewModel;
                    const isValid =
                        value !== "" || !(restoreViewModel.restoreType === RestoreType.Url);
                    return {
                        isValid: isValid,
                        validationMessage: isValid
                            ? ""
                            : LocConstants.RestoreDatabase.blobIsRequired,
                    };
                },
            }),

            relocateDbFiles: createFormItem({
                type: FormItemType.Checkbox,
                propertyName: "relocateDbFiles",
                label: LocConstants.RestoreDatabase.relocateDbFiles,
                isAdvancedOption: true,
                groupName: LocConstants.RestoreDatabase.files,
            }),

            replaceDatabase: createFormItem({
                type: FormItemType.Checkbox,
                propertyName: "replaceDatabase",
                label: LocConstants.RestoreDatabase.overwriteExistingDb,
                isAdvancedOption: true,
                groupName: LocConstants.RestoreDatabase.general,
            }),

            keepReplication: createFormItem({
                type: FormItemType.Checkbox,
                propertyName: "keepReplication",
                label: LocConstants.RestoreDatabase.preserveReplicationSettings,
                isAdvancedOption: true,
                groupName: LocConstants.RestoreDatabase.general,
            }),

            setRestrictedUser: createFormItem({
                type: FormItemType.Checkbox,
                propertyName: "setRestrictedUser",
                label: LocConstants.RestoreDatabase.restrictAccessToRestoredDb,
                isAdvancedOption: true,
                groupName: LocConstants.RestoreDatabase.general,
            }),

            recoveryState: createFormItem({
                type: FormItemType.Dropdown,
                propertyName: "recoveryState",
                label: LocConstants.RestoreDatabase.recoveryState,
                options: this.getRecoveryStateOptions(),
                isAdvancedOption: true,
                groupName: LocConstants.RestoreDatabase.general,
            }),

            backupTailLog: createFormItem({
                type: FormItemType.Checkbox,
                propertyName: "backupTailLog",
                label: LocConstants.RestoreDatabase.takeTailLogBackup,
                isAdvancedOption: true,
                groupName: LocConstants.RestoreDatabase.tailLogBackup,
            }),

            tailLogWithNoRecovery: createFormItem({
                type: FormItemType.Checkbox,
                propertyName: "tailLogWithNoRecovery",
                label: LocConstants.RestoreDatabase.leaveSourceDatabase,
                isAdvancedOption: true,
                groupName: LocConstants.RestoreDatabase.tailLogBackup,
            }),

            closeExistingConnections: createFormItem({
                type: FormItemType.Checkbox,
                propertyName: "closeExistingConnections",
                label: LocConstants.RestoreDatabase.closeExistingConnections,
                isAdvancedOption: true,
                groupName: LocConstants.RestoreDatabase.serverConnections,
            }),

            dataFileFolder: createFormItem({
                type: FormItemType.Input,
                propertyName: "dataFileFolder",
                label: LocConstants.RestoreDatabase.dataFileFolder,
                isAdvancedOption: true,
                groupName: LocConstants.RestoreDatabase.files,
            }),

            logFileFolder: createFormItem({
                type: FormItemType.Input,
                propertyName: "logFileFolder",
                label: LocConstants.RestoreDatabase.logFileFolder,
                isAdvancedOption: true,
                groupName: LocConstants.RestoreDatabase.files,
            }),

            standbyFile: createFormItem({
                type: FormItemType.Input,
                propertyName: "standbyFile",
                label: LocConstants.RestoreDatabase.standbyFile,
                isAdvancedOption: true,
                groupName: LocConstants.RestoreDatabase.general,
            }),

            tailLogBackupFile: createFormItem({
                type: FormItemType.Input,
                propertyName: "tailLogBackupFile",
                label: LocConstants.RestoreDatabase.tailLogBackupFile,
                isAdvancedOption: true,
                groupName: LocConstants.RestoreDatabase.tailLogBackup,
            }),
        };
    }

    private getRecoveryStateOptions(): FormItemOptions[] {
        return [
            {
                value: RecoveryState.WithRecovery,
                displayName: LocConstants.RestoreDatabase.restoreWithRecovery,
            },
            {
                value: RecoveryState.NoRecovery,
                displayName: LocConstants.RestoreDatabase.restoreWithNoRecovery,
            },
            {
                value: RecoveryState.Standby,
                displayName: LocConstants.RestoreDatabase.restoreWithStandby,
            },
        ];
    }
    //#endregion

    private async restoreHelper(taskMode: TaskExecutionMode): Promise<RestoreResponse> {
        const params = this.getRestoreParams(taskMode, false, false);
        return await this.objectManagementService.restoreDatabase(params);
    }
    private async getRestorePlan(useDefaults: boolean): Promise<RestorePlanResponse> {
        const params = this.getRestoreParams(TaskExecutionMode.execute, true, useDefaults);
        return await this.objectManagementService.getRestorePlan(params);
    }

    private async createRestoreConnectionContext(databaseName: string): Promise<void> {
        // If we have an existing connection for a different database, disconnect it
        if (this.state.ownerUri && this.state.ownerUri !== this.node.sessionId) {
            void this.connectionManager.disconnect(this.state.ownerUri);
        }

        const databaseConnectionUri = `${databaseName}_${this.node.sessionId}`;

        // Create a new temp connection for the database if we are not already connected
        // This lets sts know the context of the database we are backing up; otherwise,
        // sts will assume the master database context
        await this.connectionManager.connect(databaseConnectionUri, {
            ...this.node.connectionProfile,
            database: databaseName,
        });

        this.state.ownerUri = databaseConnectionUri;
    }

    private getRestoreParams(
        taskMode: TaskExecutionMode,
        shouldOverwrite: boolean,
        useDefaults: boolean,
    ): RestoreParams {
        let restoreViewModel = this.restoreViewModel();
        const restoreFromDatabase = restoreViewModel.restoreType === RestoreType.Database;

        let backupFilePaths = null;
        if (restoreViewModel.restoreType === RestoreType.BackupFile) {
            backupFilePaths = restoreViewModel.backupFiles.map((f) => f.filePath).join(",");
        } else if (restoreViewModel.restoreType === RestoreType.Url) {
            backupFilePaths = this.getRestoreUrl(this.state.formState, restoreViewModel);
        }

        let backupSets = null;
        if (!shouldOverwrite && restoreViewModel.restorePlan) {
            backupSets = restoreViewModel.restorePlan.backupSetsToRestore?.map((bs) => bs.id);
        }
        const restoreInfo: RestoreInfo = {
            targetDatabaseName: useDefaults ? "master" : this.state.formState.targetDatabaseName,
            sourceDatabaseName: useDefaults ? null : this.state.formState.sourceDatabaseName,
            relocateDbFiles: this.state.formState.relocateDbFiles,
            readHeaderFromMedia: restoreFromDatabase ? false : true,
            overwriteTargetDatabase: shouldOverwrite,
            backupFilePaths: backupFilePaths,
            deviceType:
                restoreViewModel.restoreType === RestoreType.Url
                    ? MediaDeviceType.Url
                    : MediaDeviceType.File,
            selectedBackupSets: backupSets,
        };

        const options: { [key: string]: any } = {};
        if (restoreViewModel.restorePlan) {
            restoreViewModel = this.handlePlanUpdate(false, restoreViewModel);

            for (const key in restoreViewModel.restorePlan.planDetails) {
                options[key] = restoreViewModel.restorePlan.planDetails[key];
            }
        }
        for (const key in restoreInfo) {
            options[key] = restoreInfo[key];
        }

        const params: RestoreParams = {
            ...restoreInfo,
            ownerUri: useDefaults ? this.node.sessionId : this.state.ownerUri,
            options: options,
            taskExecutionMode: taskMode,
        };
        return params;
    }

    private handlePlanUpdate(
        shouldUpdateState: boolean,
        restoreViewModel?: RestoreDatabaseViewModel,
    ): RestoreDatabaseViewModel {
        if (restoreViewModel === undefined) {
            restoreViewModel = this.restoreViewModel();
        }
        if (shouldUpdateState) {
            for (const key in restoreViewModel.restorePlan?.planDetails) {
                if (key in this.state.formState) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (this.state.formState[key] as any) =
                        restoreViewModel.restorePlan?.planDetails[key].defaultValue;
                } else if (key in restoreViewModel) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (restoreViewModel[key] as any) =
                        restoreViewModel.restorePlan?.planDetails[key].defaultValue;
                }
            }
        } else {
            for (const key in this.state.formState) {
                if (key in restoreViewModel.restorePlan?.planDetails) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    restoreViewModel.restorePlan.planDetails[key].currentValue =
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        this.state.formState[key] as any;
                }
            }
            for (const key in restoreViewModel) {
                if (key in restoreViewModel.restorePlan?.planDetails) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    restoreViewModel.restorePlan.planDetails[key].currentValue =
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        restoreViewModel[key] as any;
                }
            }
        }
        return restoreViewModel;
    }

    private async loadBlobComponent(
        state: ObjectManagementWebviewState<RestoreDatabaseFormState>,
    ): Promise<ObjectManagementWebviewState<RestoreDatabaseFormState>> {
        const restoreViewModel = this.restoreViewModel(state);
        const blobComponent = state.formComponents["blob"];

        // if no storage account or subscription selected, set error state and return
        if (
            !state.formState.subscriptionId ||
            !state.formState.storageAccountId ||
            !state.formState.blobContainerId
        ) {
            restoreViewModel.azureComponentStatuses["blob"] = ApiStatus.Error;
            blobComponent.placeholder = LocConstants.RestoreDatabase.noBlobsFound;
            return state;
        }

        // Load storage accounts for selected subscription
        const subscription = restoreViewModel.subscriptions.find(
            (s) => s.subscriptionId === state.formState.subscriptionId,
        );
        const storageAccount = restoreViewModel.storageAccounts.find(
            (sa) => sa.id === state.formState.storageAccountId,
        );
        const blobContainer = restoreViewModel.blobContainers.find(
            (bc) => bc.id === state.formState.blobContainerId,
        );
        let blobs: BlobItem[] = [];
        try {
            blobs = await VsCodeAzureHelper.fetchBlobsForContainer(
                subscription,
                storageAccount,
                blobContainer,
            );
        } catch (error) {
            state.errorMessage = error.message;
        }
        const blobOptions: FormItemOptions[] = blobs.map((blob) => ({
            value: blob.name,
            displayName: blob.name,
        }));

        // Set associated state values
        blobComponent.options = blobOptions;
        state.formState.blob = blobOptions.length > 0 ? blobOptions[0].value : "";
        blobComponent.placeholder =
            blobOptions.length > 0
                ? LocConstants.RestoreDatabase.selectABlob
                : LocConstants.RestoreDatabase.noBlobsFound;
        restoreViewModel.blobs = blobs;

        state.viewModel.model = restoreViewModel;
        return state;
    }

    private getRestoreUrl(
        formState: RestoreDatabaseFormState,
        restoreViewModel: RestoreDatabaseViewModel,
    ): string {
        const accountEndpoint =
            getCloudProviderSettings().settings.azureStorageResource.endpoint.replace(https, "");
        const storageAccount = restoreViewModel.storageAccounts.find(
            (sa) => sa.id === formState.storageAccountId,
        );
        const blobContainer = restoreViewModel.blobContainers.find(
            (bc) => bc.id === formState.blobContainerId,
        );

        const blobContainerUrl = `${https}${storageAccount.name}.${accountEndpoint}${blobContainer.name}`;
        const backupUrl = `${blobContainerUrl}/${formState.blob}`;
        return backupUrl;
    }
}
