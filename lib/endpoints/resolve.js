/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Restify handlers for retrieving VM rules
 */

'use strict';

var fw = require('../rule');
var mod_persist = require('../persist');
var mod_err = require('../errors');
var util = require('util');
var validate = require('restify-warden');
var constants = require('../util/constants');

var hasKey = require('jsprim').hasKey;


// --- Internal helpers

function validateTags(_, name, tags, callback) {
    if (typeof (tags) !== 'object') {
        callback(new mod_err.invalidParam(name, constants.msg.OBJ));
        return;
    }
    callback(null, tags);
}

var RESOLVE_SCHEMA = {
    required: {
        owner_uuid: validate.UUID
    },
    optional: {
        tags: validateTags,
        tag: validate.string,
        vms: validate.UUIDarray,
        ips: validate.IParray,
        allVMs: validate.boolean
    }
};

/**
 * If a rule matches the default firewall behaviour (allow outbound, block
 * inbound), then there's no need for firewaller to try and fetch the mentioned
 * remote VMs from VMAPI.
 */
function isNoOpRule(rule, d) {
    var p = rule.priority;
    var a = rule.action;

    if (p > 0) {
        /*
         * We don't bother trying to determine whether or not a rule
         * with PRIORITY is effectively a no-op, since it would require
         * examining all other applied rules with a lower priority.
         */
        return false;
    }

    return (d === 'from' && a === 'allow') || (d === 'to' && a === 'block');
}

/**
 * For targets specified by params, determine the targets on the other side
 * of the rules
 */
function resolveTargets(rules, params, log, callback) {
    var allVMs = false;
    var sideData = {
        tags: {},
        vms: {}
    };
    if (hasKey(params, 'vms')) {
        params.vms = params.vms.reduce(function (acc, vm) {
            acc[vm] = 1;
            return acc;
        }, {});
    }

    function addOtherSideData(rule, d) {
        if (isNoOpRule(rule, d)) {
            log.debug(
                'resolveTargets: rule %s: match on side %s, but action is %s',
                rule.uuid, d, rule.action);
            return;
        }

        var otherSide = (d === 'from' ? 'to' : 'from');

        if (rule[otherSide].wildcards.indexOf('vmall') !== -1) {
            allVMs = true;
        }

        rule[otherSide].tags.forEach(function (tag) {
            if (!util.isArray(tag)) {
                sideData.tags[tag] = true;
            } else {
                if (sideData.tags[tag[0]] !== true) {
                    if (!hasKey(sideData.tags, tag[0])) {
                        sideData.tags[tag[0]] = [];
                    }

                    sideData.tags[tag[0]].push(tag[1]);
                }
            }
        });
        rule[otherSide].vms.forEach(function (vm) {
            sideData.vms[vm] = 1;
        });
    }

    rules.forEach(function (rule) {
        var matched = false;

        log.debug({ params: params, from: rule.from, to: rule.to },
            'resolveTargets: rule %s: finding side matches', rule.uuid);

        fw.DIRECTIONS.forEach(function (dir) {
            if (rule[dir].wildcards.indexOf('vmall') !== -1) {
                log.debug('resolveTargets: matched rule=%s, dir=%s, allVMs',
                    rule.uuid, dir);
                matched = true;
                addOtherSideData(rule, dir);
                return;
            }

            if (hasKey(params, 'tags')) {
                rule[dir].tags.forEach(function (tag) {
                    var tagKey = tag;
                    var tagVal = true;
                    if (util.isArray(tag)) {
                        tagKey = tag[0];
                        tagVal = tag[1];
                    }

                    if (tagMatches(tagKey, tagVal, params.tags)) {
                        matched = true;
                        log.debug('resolveTargets: matched rule=%s, dir=%s, '
                            + 'tag=%s', rule.uuid, dir, tag);
                        addOtherSideData(rule, dir);
                    }
                });
            }

            if (hasKey(params, 'vms')) {
                rule[dir].vms.forEach(function (vm) {
                    if (hasKey(params.vms, vm)) {
                        matched = true;
                        log.debug('resolveTargets: matched rule=%s, dir=%s, '
                            + 'vm=%s', rule.uuid, dir, vm);
                        addOtherSideData(rule, dir);
                        return;
                    }
                });
            }
            // XXX: subnet
        });

        if (!matched) {
            log.warn('resolveTargets: rule %s: no matching tags or VMs found',
                rule.uuid);
        }
    });

    for (var type in sideData) {
        if (type !== 'tags') {
            sideData[type] = Object.keys(sideData[type]).sort();
        }
    }

    sideData.allVMs = allVMs;
    if (hasKey(params, 'owner_uuid')) {
        sideData.owner_uuid = params.owner_uuid;
    }

    return callback(null, sideData);
}


/**
 * Returns true if the rule tag (key, val) matches the same tag in
 * tagsWanted.  A tag in a rule can match if:
 *   - we wanted tag key, and the rule has tag key=<anything>
 *   - we wanted tag key=val, and the rule has key=val
 *   - we wanted tag key=val, and the rule has tag key (with
 *     no value)
 */
function tagMatches(key, val, tagsWanted) {
    if (!hasKey(tagsWanted, key)) {
        return false;
    }

    if (tagsWanted[key] === true) {
        return true;
    }

    if (val === true) {
        return true;
    }

    // Array of tag values means we are looking for multiple tag values
    var wantedVals = [];

    if (util.isArray(tagsWanted[key])) {
        wantedVals = tagsWanted[key];
    } else {
        wantedVals = [ tagsWanted[key] ];
    }

    for (var v in wantedVals) {
        if (wantedVals[v] === val) {
            return true;
        }
    }

    return false;
}



// --- Restify handlers



/*
 * Returns all data necessary to firewall the given VM:
 * - All rules that apply to that VM or its tags
 * - Parameters that can be used to lookup other VMs on the other side of
 *   the rules in VMAPI:
 *   - tags, eg: "tags": { "one": "val" }
 *   - tag, eg: "tag": "myTag"
 *   - vms, eg: "vms": [ "<UUID 1>", "<UUID 2>" ]
 *   - allVMs (whether or not one of the rules contains "all vms"),
 *     eg: "allVMs": true
 */
function resolve(req, res, next) {
    // ips, owner_uuid, tags, vms
    validate.params(RESOLVE_SCHEMA, null, req.params,
        function (err, validated) {
        if (err) {
            next(err);
            return;
        }

        mod_persist.vmRules(req._app, req.log, validated,
            function (err1, rules) {
            if (err1) {
                next(err1);
                return;
            }

            resolveTargets(rules, validated, req.log,
                function (err2, sideData) {
                if (err2) {
                    next(err2);
                    return;
                }

                var payload = {
                    rules: rules.map(function (r) {
                        return r.serialize();
                    })
                };

                for (var type in sideData) {
                    payload[type] = sideData[type];
                }

                res.send(200, payload);
                next();
            });
        });
    });
}



// --- Exports



/**
 * Registers endpoints with a restify server
 */
function register(server, before) {
    server.post({ path: '/resolve', name: 'resolve' },
            before, resolve);
}



module.exports = {
    register: register
};
