/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { IRemoteAgentHostService, NullRemoteAgentHostService } from '../common/remoteAgentHostService.js';

registerSingleton(IRemoteAgentHostService, NullRemoteAgentHostService, InstantiationType.Delayed);
