import gui from 'gui';
import { winRef } from './utils/gui-winref.js';
import { assignFieldsValues, createForm, createTabbedForm } from './utils/gui-form-builder.js';
import { promptError, promptYesNo } from './utils/prompt.js';
import { miscImages } from './services/images.js';
import packageJson from './utils/package-json.js';
import { getBookmarkConfig, getProvider } from './services/rclone.js';
import * as rclone from './services/rclone.js';
import { createWebViewWindow } from './webview.js';

/**
 * @param {string} bookmarkName
 * @param {object} providerConfig
 * @param {gui.Window=} parentWindow
 */
export async function createClonedBookmarkWindow(bookmarkName, providerConfig, parentWindow) {
    const config = await getBookmarkConfig(bookmarkName);
    if (!providerConfig) {
        promptError({
            title: `Clone bookmark ${bookmarkName}`,
            message: `The remote type: ${config.type} is not supported by Rclone.`,
            parentWindow,
        });
        return;
    }

    createBookmarkWindow(
        true,
        {
            name: bookmarkName + '_cloned',
            providerConfig,
            type: config.type,
            values: config,
        },
        parentWindow
    );

    parentWindow.close();
}

/**
 * @param {string} bookmarkName
 * @param {gui.Window=} parentWindow
 */
export async function createBookmarkWindowByName(bookmarkName, parentWindow) {
    const config = await getBookmarkConfig(bookmarkName);
    const providerConfig = await getProvider(config.type);
    if (!providerConfig) {
        promptError({
            title: `Edit bookmark ${config.type}`,
            message: `The remote type: ${config.type} is not supported by Rclone.`,
            parentWindow,
        });
        return;
    }

    createBookmarkWindow(
        false,
        {
            name: bookmarkName,
            providerConfig,
            type: config.type,
            values: config,
        },
        parentWindow
    );
}
/**
 * @param {boolean} isNew
 * @param {{
 *  name?: string,
 *  type: string,
 *  providerConfig: import('./services/rclone.js').RcloneProvider,
 *  values?: object,
 * }} options
 * @actions {{create, delete, cloneDialog }}
 * @param {gui.Window=} parentWindow
 */
export default function createBookmarkWindow(isNew, { name, type, providerConfig, values }, parentWindow) {
    const win = winRef(`edit-bookrmark-${name}-${isNew}`);

    if (win.value) return win.value;

    win.value = gui.Window.create({ showTrafficLights: true });
    win.value.setResizable(true);
    win.value.setMaximizable(false);
    process.platform !== 'darwin' && win.value.setIcon(miscImages.rcloneColor);
    win.value.setContentSizeConstraints({ width: 520, height: 560 }, { width: 860, height: 1080 });
    if (parentWindow) {
        win.value.setBounds({
            width: 560,
            height: 640,
            x: parentWindow.getBounds().x,
            y: parentWindow.getBounds().y,
        });
    } else {
        win.value.setContentSize({ width: 560, height: 640 });
    }

    if (isNew) {
        setWindowCreateTitle('New');
    } else {
        win.value.setTitle(`Edit ${name} - ${packageJson.displayName}`);
    }

    const contentView = gui.Container.create();
    contentView.setStyle({ padding: 10 });
    win.value.setContentView(contentView);

    const systemForm = createForm([
        {
            Name: 'name',
            Type: 'string',
            Readonly: !isNew,
            Value: name || 'Unnamed',
            OnChange: setWindowCreateTitle,
            Help: isNew ? 'Once set, cannot be changed' : '',
        },
        {
            Readonly: true,
            Type: 'string',
            Name: 'type',
            Help: providerConfig.Description,
            Enums: [
                {
                    Value: type,
                },
            ],
            Value: type,
        },
    ]);

    contentView.addChildView(systemForm.container);

    const propertyForm = createTabbedForm([
        {
            label: 'General',
            enableScroll: true,
            fields: assignFieldsValues(
                providerConfig.Options.filter((a) => !a.Advanced && !a.Hide),
                values || {}
            ),
        },
        {
            label: 'Advanced',
            enableScroll: true,
            fields: assignFieldsValues(
                providerConfig.Options.filter((a) => a.Advanced && !a.Hide),
                values || {}
            ),
        },
        {
            label: 'Misc',
            enableScroll: true,
            fields: assignFieldsValues(
                [
                    {
                        Type: 'bool',
                        Name: 'rclonetray_automount',
                        Title: 'Mount on start',
                    },
                    {
                        Type: 'bool',
                        Name: 'rclonetray_pullonstart',
                        Title: 'Pull on start',
                    },
                    {
                        Type: 'string',
                        FileDialog: 'folder',
                        Name: 'rclonetray_local_directory',
                        Title: 'Sync Directory',
                        Help: 'Local directory to use when sync',
                    },
                ],
                values || {}
            ),
        },
    ]);
    contentView.addChildView(propertyForm.container);

    const actionButtonsWrapper = gui.Container.create();
    actionButtonsWrapper.setStyle({
        flexGrow: 0,
        alignSelf: 'flex-end',
        justifyContent: 'flex-end',
        flexDirection: 'row',
        paddingTop: 10,
    });
    contentView.addChildView(actionButtonsWrapper);

    const actionButtonDoc = gui.Button.create('Online Docs');
    actionButtonDoc.setStyle({ marginLeft: 10 });
    actionButtonsWrapper.addChildView(actionButtonDoc);
    actionButtonDoc.onClick = providerDocsAction;

    if (!isNew) {
        const actionButtonDelete = gui.Button.create('Delete');
        actionButtonDelete.setStyle({ marginLeft: 10 });
        actionButtonsWrapper.addChildView(actionButtonDelete);
        actionButtonDelete.onClick = (self) => deleteAction({ name, self });
    }

    if (!isNew) {
        const actionButtonClone = gui.Button.create('Clone');
        actionButtonClone.setStyle({ marginLeft: 10 });
        actionButtonClone.setEnabled(!isNew);
        actionButtonsWrapper.addChildView(actionButtonClone);
        actionButtonClone.onClick = (self) => cloneAction({ name, providerConfig, self });
    }

    const actionButtonSave = gui.Button.create(isNew ? 'Create' : 'Save');
    actionButtonSave.setStyle({ marginLeft: 10 });
    if (isNew) {
        actionButtonSave.onClick = (self) => createNewAction({ self, systemForm, propertyForm });
    } else {
        actionButtonSave.onClick = (self) => saveAction({ self, providerConfig, name, systemForm, propertyForm });
    }
    actionButtonsWrapper.addChildView(actionButtonSave);

    win.value.setVisible(true);
    win.value.activate();

    return win.value;

    function providerDocsAction() {
        createWebViewWindow('https://rclone.org/' + type + '/', providerConfig.Description, win.value);
    }

    function setWindowCreateTitle(name) {
        win.value.setTitle(`Create ${name} ${type} bookmark - ${packageJson.productName}`);
    }
}

/**
 * @param {{ name: string, providerConfig: object, self: gui.Button }} _
 */
async function cloneAction({ name, providerConfig, self }) {
    if (!name) return;

    promptYesNo(
        {
            title: `Clone ${name} as new?`,
            message: `Clone ${name} bookmark and proceed to settings?`,
            parentWindow: self.getWindow(),
        },
        (result) => {
            if (!result) return;
            if (self.getWindow()) {
                self.getWindow().deactivate();
            }
            createClonedBookmarkWindow(name, providerConfig, self.getWindow());
        }
    );
}

/**
 * @param {{ name: string, self: gui.Button }} _
 */
async function deleteAction({ name, self }) {
    if (!name) return;

    promptYesNo(
        {
            title: `Delete ${name}?`,
            message: `Are you sure you want to delete ${name} bookmark?`,
            parentWindow: self.getWindow(),
        },
        async (result) => {
            if (!result) return;
            try {
                await rclone.deleteBookmark(name);
                if (self.getWindow()) {
                    self.getWindow().close();
                }
            } catch (error) {
                promptError({
                    title: `Failed to delete bookmark - ${name}`,
                    message: error,
                    parentWindow: self.getWindow(),
                });
            }
        }
    );
}

/**
 * @param {{
 *  self: gui.Button,
 *  systemForm: import('./utils/gui-form-builder.js').Form,
 *  propertyForm: import('./utils/gui-form-builder.js').Form
 * }} _
 */
async function createNewAction({ self, systemForm, propertyForm }) {
    let values;
    try {
        values = propertyForm.getValues();
    } catch (error) {
        promptError({
            title: 'Invalid values',
            message: error.toString(),
            parentWindow: self.getWindow(),
        });
        return;
    }

    const systemFieldsValues = systemForm.getValues();

    try {
        await rclone.createBookmark(systemFieldsValues.name, systemFieldsValues.type, values);
        self.getWindow().close();
    } catch (error) {
        promptError({
            title: `Failed to create bookmark - ${systemFieldsValues.name}`,
            message: error,
            parentWindow: self.getWindow(),
        });
    }
}

/**
 * @param {{
 *  name: string,
 *  providerConfig: object,
 *  self: gui.Button,
 *  systemForm: import('./utils/gui-form-builder.js').Form,
 *  propertyForm: import('./utils/gui-form-builder.js').Form
 * }} _
 */
async function saveAction({ name, self, propertyForm }) {
    if (!name) return;

    let values;
    try {
        values = propertyForm.getValues();
    } catch (error) {
        promptError({
            title: 'Invalid values',
            message: error.toString(),
            parentWindow: self.getWindow(),
        });
        return;
    }

    try {
        await rclone.updateBookmark(name, values);
        self.getWindow().close();
    } catch (error) {
        promptError({
            title: `Failed to create bookmark - ${name}`,
            message: error,
            parentWindow: self.getWindow(),
        });
    }
}
