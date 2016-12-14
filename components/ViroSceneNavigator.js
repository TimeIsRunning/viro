/**
 * Copyright (c) 2015-present, Viro Media, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ViroSceneNavigator
 * @flow
 */
'use strict';

var NativeMethodsMixin = require('react/lib/NativeMethodsMixin');
var NativeModules = require('NativeModules');
var PropTypes = require('react/lib/ReactPropTypes');
var React = require('React');
var invariant = require('fbjs/lib/invariant');
var findNodeHandle = require('react/lib/findNodeHandle');
var ViroSceneNavigatorManager = require('NativeModules').SceneNavigatorManager;
import { requireNativeComponent, View, StyleSheet } from 'react-native';
var SCENE_NAVIGATOR_REF = 'viroscenenavigator';

type Scene = {
  scene: Function;
  passProps?: Object,
};

var mathRandomOffset = 0;

/**
 * ViroSceneNavigator is used to transition between multiple scenes.
 */
var ViroSceneNavigator = React.createClass({
  mixins: [NativeMethodsMixin],

  propTypes: {
        /**
         * Calling vrModeEnabled allows switching to and from VR mode.
         * When set to false, it transitions back to pre-VR (mono) mode.
         * When set to true, we set thie view into a full VR mode.
         * This is set to true by default.
         */
        vrModeEnabled: PropTypes.bool,

        ...View.propTypes,
        /**
         * ViroSceneNavigator uses "scene" objects like the following to
         * describe a scene.
         */
        initialScene: PropTypes.shape({
          /**
           * The React Class to render for this scene.
           */
        scene: PropTypes.func.isRequired,
      }).isRequired,
  },

  sceneNavigator: (undefined: ?Object),

  getDefaultProps: function() {
    return {
      // Make sure viroAppProps aren't null to save us having to always check
      viroAppProps: {},
      vrModeEnabled: true,
    };
  },

  componentWillMount: function() {
    // Precompute a pack of callbacks that's frequently generated and passed to
    // instances.
    this.sceneNavigator = {
      push: this.push,
      pop: this.pop,
      popN: this.popN,
      jump: this.jump,
      // pass the viroAppProps to every scene, these aren't meant to ever change.
      viroAppProps: this.props.viroAppProps,
      requestExit: this.requestExit,
    };
    // If the user simply passes us the props from the root React component, then we'll
    // have an extra 'rootTag' key which React includes.
    delete this.sceneNavigator.viroAppProps.rootTag;
  },

  getInitialState: function(): State {
    var initialSceneTag = this.props.initialSceneKey;
    if (initialSceneTag == null){
        initialSceneTag = this.getRandomTag();
    }
    var scene = {
        sceneClass:this.props.initialScene,
        tag: initialSceneTag,
        referenceCount:1
    };
    var sceneDict = {};
    sceneDict[scene.tag] = scene;
    return {
      sceneDictionary:sceneDict,
      sceneHistory:[scene.tag],
      currentSceneIndex: 0,
    };
  },

  getRandomTag(){
    var randomTag = Math.random() + mathRandomOffset;
    mathRandomOffset ++;
    return randomTag.toString();
  },

  /**
   * Pushes a scene and reference it with the given key if provided.
   * If the scene has been previously pushed, we simply show the scene again.
   * Note that the back history order of which scenes were pushed is preserved.
   * Also note that scenes are reference counted and only a unique set of
   * scenes are stored and mapped to within sceneDictionary.
   *
   * Can take in either 1 or two parameters in the form:
   * push ("sceneKey");
   * push ("sceneKey", scene);
   * push (scene);
   */
  push: function(param1, param2){
    var sceneKey = undefined;
    var scene = undefined;
    if (typeof param1 == 'string'){
        sceneKey = param1;
        scene = param2;
    } else {
        scene = param1;
    }

    if (scene == undefined && sceneKey == undefined){
        console.log("ERROR: pushing requires either the scene tag, or both the tag and scene.");
        return;
    } else if (scene == undefined && sceneKey != undefined
          && !(sceneKey in this.state.sceneDictionary)){
        console.log("ERROR: Cannot push with a new sceneKey with no associated scene.");
        return;
      }

    if (sceneKey == undefined || (typeof sceneKey == 'string' && sceneKey.trim().length <=0)){
        sceneKey = this.getRandomTag();
    }

    this.incrementSceneReference(scene, sceneKey, false);
    this.addToHistory(sceneKey);
  },

  /**
   * Jumps to a given scene that had been previously pushed. If the scene was not pushed, we
   * then push and jump to it. The back history is re-ordered such that jumped to scenes are
   * re-ordered to the front. As such, only the back order of sequential jumps are preserved.
   *
   * Can take in either 1 or two parameters in the form:
   * jump ("sceneKey");
   * jump ("sceneKey", scene);
   * jump (scene);
   */
  jump: function(param1, param2){
    var sceneKey = undefined;
    var scene = undefined;
    if (typeof param1 == 'string'){
        sceneKey = param1;
        scene = param2;
    } else {
        scene = param1;
    }

    if (scene == undefined && sceneKey == undefined){
        console.log("ERROR: jumping requires either the scene tag, or both the tag and scene.");
        return;
    } else if (scene == undefined && sceneKey != undefined
        && !(sceneKey in this.state.sceneDictionary)){
        console.log("ERROR: Cannot jump with a new sceneKey with no associated scene.");
        return;
    }

    if (sceneKey == undefined || (typeof sceneKey == 'string' && sceneKey.trim().length <=0)){
        sceneKey = this.getRandomTag();
    }

    this.incrementSceneReference(scene, sceneKey, true);
    this.reorderHistory(sceneKey);
  },

  pop: function() {
    this.popN(1);
  },

  popN: function(n: number) {
    if (n === 0) {
        return;
    }

    // Sanity check to ensure we can pop n scenes.
    var newTagStackIndex = 0;
    if (this.state.sceneHistory.length > 0) {
        newTagStackIndex = this.state.sceneHistory.length -1 - n;
        invariant(newTagStackIndex >= 0, 'Cannot pop below 0');
    }

    this.decrementReferenceForLastNScenes(n);
    this.popHistoryByN(n);
  },

  /**
   * Increments the reference count for a scene within sceneDictionary that is
   * mapped to the given sceneKey. If no scenes are found / mapped, we create
   * one, initialize it with a reference count of 1, and store it within the
   * sceneDictionary for future reference.
   */
  incrementSceneReference: function(scene:Scene, scenekey:String, limitOne:Boolean){
    var currentSceneDictionary = this.state.sceneDictionary;
    if (!(scenekey in currentSceneDictionary)){
      var newScene = {
          sceneClass:scene,
          tag:scenekey,
          referenceCount:0
      };
      currentSceneDictionary[scenekey] = newScene;
    }

    // Error out if there are no scenes matching the given sceneKey
    var currentScene = currentSceneDictionary[scenekey];
    if (currentScene == null || currentScene == "undefined"){
        console.log("ERROR: No scene found for: " + sceneKey);
        return;
    }

    // Update the scene's reference count and then the sceneDictionary
    if ((limitOne && currentScene.referenceCount <1) || !limitOne){
        currentScene.referenceCount++;
    }

    currentSceneDictionary[scenekey] = currentScene;

    // Finally update all states
    this.setState({
      sceneDictionary: currentSceneDictionary,
    });
  },

  /**
   * Decrements the reference count for the last N scenes within
   * the sceneHistory by 1. If nothing else references that given scene
   * (counts equals 0), we then remove that scene from sceneDictionary.
   */
  decrementReferenceForLastNScenes: function(n){
    var sceneHistory = this.state.sceneHistory;
    var sceneDictionary = this.state.sceneDictionary;

    // Now update and release any reference counts
    for (var i = 1; i <= n ; i ++){
        var sceneTag = sceneHistory[sceneHistory.length - i];
        var scene = sceneDictionary[sceneTag];
        scene.referenceCount --;

        if (scene.referenceCount <=0){
            delete sceneDictionary[sceneTag];
        } else {
            sceneDictionary[sceneTag] = scene;
        }
    }

    // Finally update all states
    this.setState({
        sceneDictionary: sceneDictionary
    });
  },

  /**
   * Adds the given sceneKey to the sceneHistory and updates the currentSceneIndex to point
   * to the scene on the top of the history stack (the most recent scene).
   */
  addToHistory: function(sceneKey:String){
    var updatedHistory = this.state.sceneHistory.concat([sceneKey]);
    var currentIndex = this.getSceneIndex(sceneKey);
    this.setState({
        currentSceneIndex: currentIndex,
        sceneHistory: updatedHistory,
    });
  },

  /**
   * Instead of preserving history, we find the last pushed sceneKey within the history stack
   * matching the given sceneKey and re-order it to the front. We then updates the
   * currentSceneIndex to point to the scene on the top of the history stack
   * (the most recent scene).
   */
  reorderHistory: function(sceneKey:String){
    // Find the last sceneKey within sceneHistory and remove it.
    var sceneHistory = this.state.sceneHistory;
    for (var i = sceneHistory.length-1; i >= 0; i --){
        if (sceneKey == sceneHistory[i]){
            sceneHistory.splice(i,1);
            break;
        }
    }

    // Add back the sceneKey to the front of the History stack.
    var updatedHistory = sceneHistory.concat([sceneKey]);
    var currentIndex = this.getSceneIndex(sceneKey);
    this.setState({
        currentSceneIndex: currentIndex,
        sceneHistory: updatedHistory,
    });
  },

  popHistoryByN: function(n){
    var sceneHistory = this.state.sceneHistory;
    sceneHistory.splice(sceneHistory.length - n,n);
    var currentIndex = this.getSceneIndex(sceneHistory[sceneHistory.length-1]);

    // Finally update all states
    this.setState({
        currentSceneIndex: currentIndex,
        sceneHistory: sceneHistory,
    });
  },

  getSceneIndex(sceneTag){
    var sceneDictionary = this.state.sceneDictionary;
    var i = 0;
    for (var sceneKey in sceneDictionary){
        if (sceneTag == sceneDictionary[sceneKey].tag){
            return i;
        }
        i++;
    }
    // Unable to find the given sceneTag, return -1
    return -1;
  },

  _getNodeHandle: function(): any {
    return findNodeHandle(this.refs[SCENE_NAVIGATOR_REF]);
  },

  _renderSceneStackItems: function() {
      let views = [];
      var i = 0;
      var sceneDictionary = this.state.sceneDictionary;
      for (var scene in sceneDictionary){
          var Component = sceneDictionary[scene].sceneClass.scene;
          views.push((<Component key={'scene' + i} sceneNavigator={this.sceneNavigator} {...scene.passProps}/>));
          i++;
      }
      return views;
  },

  render: function() {
    var items = this._renderSceneStackItems();
    return (
      <VRTSceneNavigator
        ref={SCENE_NAVIGATOR_REF}
        {...this.props}
        currentSceneIndex={this.state.currentSceneIndex}
        style={this.props.style, styles.container}>
        {items}
      </VRTSceneNavigator>
    );
  },
});


var styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});

var VRTSceneNavigator = requireNativeComponent(
    'VRTSceneNavigator', ViroSceneNavigator, {
        nativeOnly: { currentSceneIndex:-1 }
    }
);

module.exports = ViroSceneNavigator;