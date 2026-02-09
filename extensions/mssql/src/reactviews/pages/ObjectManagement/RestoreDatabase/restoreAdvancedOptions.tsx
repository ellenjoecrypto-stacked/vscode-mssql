/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
    Accordion,
    AccordionHeader,
    AccordionItem,
    AccordionPanel,
    Button,
    DrawerBody,
    DrawerHeader,
    DrawerHeaderTitle,
    OverlayDrawer,
    SearchBox,
} from "@fluentui/react-components";
import { Dismiss24Regular } from "@fluentui/react-icons";
import { locConstants } from "../../../common/locConstants";
import { useContext, useState } from "react";
import { FormField } from "../../../common/forms/form.component";
import { useAccordionStyles } from "../../../common/styles";
import {
    ObjectManagementFormItemSpec,
    ObjectManagementWebviewState,
} from "../../../../sharedInterfaces/objectManagement";
import {
    RestoreDatabaseContext,
    RestoreDatabaseContextProps,
} from "./restoreDatabaseStateProvider";
import {
    RecoveryState,
    RestoreDatabaseFormState,
    RestoreDatabaseViewModel,
    RestoreType,
} from "../../../../sharedInterfaces/restore";
import { FileBrowserProvider } from "../../../../sharedInterfaces/fileBrowser";
import { FileBrowserDialog } from "../../../common/FileBrowserDialog";

export const AdvancedOptionsDrawer = ({
    isAdvancedDrawerOpen,
    setIsAdvancedDrawerOpen,
}: {
    isAdvancedDrawerOpen: boolean;
    setIsAdvancedDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) => {
    const context = useContext(RestoreDatabaseContext);
    const state = context?.state;

    if (!context || !state) {
        return;
    }

    const [searchSettingsText, setSearchSettingText] = useState<string>("");
    const [userOpenedSections, setUserOpenedSections] = useState<string[]>([]);
    const [fileBrowserProp, setFileBrowserProp] = useState<string>("");

    const accordionStyles = useAccordionStyles();

    const restoreViewModel = state.viewModel.model as RestoreDatabaseViewModel;
    const fileBrowserFields = [
        "dataFileFolder",
        "logFileFolder",
        "standbyFile",
        "tailLogBackupFile",
    ];

    const advancedOptionsByGroup: Record<
        string,
        ObjectManagementFormItemSpec<RestoreDatabaseFormState>[]
    > = Object.values(state.formComponents)
        .filter((component): component is ObjectManagementFormItemSpec<RestoreDatabaseFormState> =>
            Boolean(component && component.isAdvancedOption),
        )
        .reduce(
            (acc, component) => {
                const group = component.groupName ?? locConstants.common.general;
                if (!acc[group]) {
                    acc[group] = [];
                }
                acc[group].push(component);
                return acc;
            },
            {} as Record<string, ObjectManagementFormItemSpec<RestoreDatabaseFormState>[]>,
        );

    function isOptionVisible(option: ObjectManagementFormItemSpec<RestoreDatabaseFormState>) {
        if (searchSettingsText) {
            return (
                option.label.toLowerCase().includes(searchSettingsText.toLowerCase()) ||
                option.propertyName.toLowerCase().includes(searchSettingsText.toLowerCase())
            );
        } else {
            return true;
        }
    }

    const shouldShowGroup = (groupName: string): boolean => {
        if (
            groupName === locConstants.restoreDatabase.files &&
            restoreViewModel.restoreType !== RestoreType.BackupFile
        ) {
            return false;
        }
        return advancedOptionsByGroup[groupName].some((component) =>
            shouldShowComponent(component.propertyName),
        );
    };

    const shouldShowComponent = (componentName: string): boolean => {
        if (fileBrowserFields.includes(componentName)) {
            return shouldShowFileBrowserField(componentName);
        }
        return restoreViewModel.restorePlan?.planDetails[componentName].isReadOnly !== true;
    };

    const shouldShowFoldersOnly = (propertyName: string): boolean => {
        return propertyName === "dataFileFolder" || propertyName === "logFileFolder";
    };

    const shouldShowFileBrowserField = (propertyName: string): boolean => {
        switch (propertyName) {
            case "dataFileFolder":
            case "logFileFolder":
                return (
                    restoreViewModel.restoreType === RestoreType.BackupFile &&
                    state.formState.relocateDbFiles
                );
            case "standbyFile":
                return state.formState.recoveryState === RecoveryState.Standby;
            case "tailLogBackupFile":
                return state.formState.backupTailLog === true;
            default:
                return false;
        }
    };

    return (
        <div>
            {state.dialog?.type === "fileBrowser" && state.fileBrowserState && (
                <FileBrowserDialog
                    ownerUri={state.ownerUri}
                    defaultFilePath={state.defaultFileBrowserExpandPath}
                    fileTree={state.fileBrowserState.fileTree}
                    showFoldersOnly={state.fileBrowserState.showFoldersOnly}
                    provider={context as FileBrowserProvider}
                    fileTypeOptions={state.fileFilterOptions}
                    closeDialog={() => context.toggleFileBrowserDialog(false, false)}
                    propertyName={fileBrowserProp}
                />
            )}
            <OverlayDrawer
                position="end"
                size="medium"
                open={isAdvancedDrawerOpen}
                onOpenChange={(_, { open }) => setIsAdvancedDrawerOpen(open)}>
                <DrawerHeader>
                    <DrawerHeaderTitle
                        action={
                            <Button
                                appearance="subtle"
                                aria-label="Close"
                                icon={<Dismiss24Regular />}
                                onClick={() => setIsAdvancedDrawerOpen(false)}
                            />
                        }>
                        {locConstants.backupDatabase.advancedBackupOptions}
                    </DrawerHeaderTitle>
                </DrawerHeader>

                <DrawerBody>
                    <SearchBox
                        size="medium"
                        style={{ width: "100%", maxWidth: "100%" }}
                        placeholder={locConstants.backupDatabase.searchOptions}
                        onChange={(_e, data) => {
                            setSearchSettingText(data.value ?? "");
                        }}
                        value={searchSettingsText}
                    />
                    <Accordion
                        multiple
                        collapsible
                        onToggle={(_e, data) => {
                            if (searchSettingsText) {
                                // We don't support expanding/collapsing sections when searching
                                return;
                            } else {
                                setUserOpenedSections(data.openItems as string[]);
                            }
                        }}
                        openItems={
                            /**
                             * If the user is searching, we keep all sections open
                             * If the user is not searching, we only open the sections that the user has opened
                             */
                            searchSettingsText
                                ? Object.keys(advancedOptionsByGroup)
                                : userOpenedSections
                        }>
                        {Object.entries(advancedOptionsByGroup)
                            .filter(([_advancedGroupName, options]) =>
                                options.some((option) => isOptionVisible(option)),
                            )
                            .map(
                                ([advancedGroupName, options], groupIndex) =>
                                    shouldShowGroup(advancedGroupName) && (
                                        <AccordionItem
                                            value={advancedGroupName}
                                            key={groupIndex}
                                            className={accordionStyles.accordionItem}>
                                            <AccordionHeader>{advancedGroupName}</AccordionHeader>
                                            <AccordionPanel>
                                                {options
                                                    .filter((option) => isOptionVisible(option))
                                                    .map(
                                                        (option, idx) =>
                                                            shouldShowComponent(
                                                                option.propertyName,
                                                            ) && (
                                                                <div
                                                                    key={
                                                                        option.propertyName ?? idx
                                                                    }>
                                                                    <FormField<
                                                                        RestoreDatabaseFormState,
                                                                        ObjectManagementWebviewState<RestoreDatabaseFormState>,
                                                                        ObjectManagementFormItemSpec<RestoreDatabaseFormState>,
                                                                        RestoreDatabaseContextProps
                                                                    >
                                                                        context={context}
                                                                        component={option}
                                                                        props={
                                                                            option.componentProps ??
                                                                            {}
                                                                        }
                                                                        idx={idx}
                                                                    />

                                                                    {fileBrowserFields.includes(
                                                                        option.propertyName,
                                                                    ) && (
                                                                        <Button
                                                                            appearance="secondary"
                                                                            onClick={() => {
                                                                                setFileBrowserProp(
                                                                                    option.propertyName,
                                                                                );
                                                                                context.toggleFileBrowserDialog(
                                                                                    shouldShowFoldersOnly(
                                                                                        option.propertyName,
                                                                                    ),
                                                                                    true,
                                                                                );
                                                                            }}
                                                                            style={{
                                                                                height: "28px",
                                                                                width: "100px",
                                                                            }}>
                                                                            {
                                                                                locConstants
                                                                                    .restoreDatabase
                                                                                    .browseFiles
                                                                            }
                                                                        </Button>
                                                                    )}
                                                                </div>
                                                            ),
                                                    )}
                                            </AccordionPanel>
                                        </AccordionItem>
                                    ),
                            )}
                    </Accordion>
                </DrawerBody>
            </OverlayDrawer>
        </div>
    );
};
