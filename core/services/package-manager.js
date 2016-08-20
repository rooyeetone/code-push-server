'use strict';
var Promise = require('bluebird');
var models = require('../../models');
var security = require('../utils/security');
var _ = require('lodash');
var qetag = require('../utils/qetag');
var formidable = require('formidable');
var yazl = require("yazl");
var fs = require("fs");
var slash = require("slash");
var common = require('../utils/common');
var os = require('os');
var path = require('path');

var proto = module.exports = function (){
  function PackageManager() {

  }
  PackageManager.__proto__ = proto;
  return PackageManager;
};

proto.getMetricsbyPackageId= function(packageId) {
  return models.PackagesMetrics.findOne({where: {package_id: packageId}});
}

proto.parseReqFile = function (req) {
  return new Promise(function (resolve, reject) {
    var form = new formidable.IncomingForm();
    form.parse(req, function(err, fields, files) {
      if (err) {
        reject(new Error("upload error"));
      } else {
        if (_.isEmpty(fields.packageInfo) || _.isEmpty(files.package)) {
          reject(new Error("upload info lack"));
        } else {
          resolve({packageInfo:JSON.parse(fields.packageInfo), package: files.package});
        }
      }
    });
  });
};

proto.getDeploymentsVersions = function (deploymentId, appVersion) {
  return models.DeploymentsVersions.findOne({
    where: {deployment_id: deploymentId, app_version: appVersion}
  });
};

proto.existPackageHash = function (deploymentId, appVersion, packageHash) {
  return this.getDeploymentsVersions(deploymentId, appVersion)
  .then(function (data) {
    if (_.isEmpty(data)){
      return models.DeploymentsVersions.create({
        deployment_id: deploymentId,
        app_version: appVersion,
        is_mandatory: false,
      }).then(function () {
        return false;
      });
    } else {
      var packageId = data.current_package_id;
      if (_.gt(packageId, 0)) {
        return models.Packages.findById(packageId)
        .then(function (data) {
          if (_.eq(_.get(data,"package_hash"), packageHash)){
            return true;
          }else {
            return false;
          }
        });
      }else {
        return false
      }
    }
  });
};

proto.createPackage = function (deploymentId, appVersion, packageHash, manifestHash, blobHash, params) {
  var releaseMethod = params.releaseMethod || 'Upload';
  var releaseUid = params.releaseUid || 0;
  var isMandatory = params.isMandatory ? 1 : 0;
  var size = params.size || 0;
  var description = params.description || "";
  var originalLabel = params.originalLabel || "";
  var originalDeployment = params.originalDeployment || "";
  return models.Deployments.generateLabelId(deploymentId)
  .then(function (labelId) {
    return models.sequelize.transaction(function (t) {
      return models.DeploymentsVersions.findOne({where: {deployment_id: deploymentId, app_version: appVersion}})
      .then(function (deploymentsVersions) {
        if (!deploymentsVersions) {
          return models.DeploymentsVersions.create({
            is_mandatory: isMandatory,
            current_package_id: 0,
            deployment_id: deploymentId,
            app_version: appVersion
          },{transaction: t});
        }
        return deploymentsVersions;
      })
      .then(function(deploymentsVersions) {
        return models.Packages.create({
          deployments_versions_id: deploymentsVersions.id,
          deployment_id: deploymentId,
          description: description,
          package_hash: packageHash,
          blob_url: blobHash,
          size: size,
          manifest_blob_url: manifestHash,
          release_method: releaseMethod,
          label: "v" + labelId,
          released_by: releaseUid,
          original_label: originalLabel,
          original_deployment: originalDeployment
        },{transaction: t})
        .then(function (packages) {
          deploymentsVersions.set('is_mandatory', isMandatory);
          deploymentsVersions.set('current_package_id', packages.id);
          return Promise.all([
            deploymentsVersions.save({transaction: t}),
            models.Deployments.update({
              last_deployment_version_id: deploymentsVersions.id
            },{where: {id: deploymentId}, transaction: t})
          ])
          .then(function () {
            //插入日志
            models.DeploymentsHistory.create({
              deployment_id: deploymentId,
              package_id: packages.id,
            })
            .catch(function(e){
              console.log(e);
            });
            return packages;
          });
        });
      });
    });
  });
};

proto.downloadPackageAndExtract = function (workDirectoryPath, packageHash, blobHash) {
  var dataCenterManager = require('./datacenter-manager')();
  return dataCenterManager.validateStore(packageHash)
  .then(function (isValidate) {
    if (isValidate) {
      return dataCenterManager.getPackageInfo(packageHash);
    } else {
      var downloadURL = `${common.getDownloadUrl()}/${blobHash}`;
      return common.createFileFromRequest(downloadURL, `${workDirectoryPath}/${blobHash}`)
      .then(function (download) {
        return common.unzipFile(`${workDirectoryPath}/${blobHash}`, `${workDirectoryPath}/current`)
        .then(function (outputPath) {
          return dataCenterManager.storePackage(outputPath, true);
        });
      });
    }
  });
}

proto.zipDiffPackage = function (fileName, files, baseDirectoryPath, hotCodePushFile) {
  return new Promise(function (resolve, reject, notify) {
    var zipFile = new yazl.ZipFile();
    var writeStream = fs.createWriteStream(fileName);
    writeStream.on('error', function (error) {
      reject(error);
    })
    zipFile.outputStream.pipe(writeStream)
    .on("error", function (error) {
      reject(error);
    })
    .on("close", function () {
      resolve({ isTemporary: true, path: fileName });
    });
    for (var i = 0; i < files.length; ++i) {
      var file = files[i];
      zipFile.addFile(`${baseDirectoryPath}/${file}`, slash(file));
    }
    zipFile.addFile(hotCodePushFile, 'hotcodepush.json');
    zipFile.end();
  });
}

proto.generateOneDiffPackage = function (workDirectoryPath, packageId, dataCenter, diffPackageHash, diffManifestBlobHash) {
  var self = this;
  return models.PackagesDiff.findOne({
    where:{
      package_id: packageId,
      diff_against_package_hash: diffPackageHash
    }
  })
  .then(function (diffPackage) {
    if (!_.isEmpty(diffPackage)) {
      return;
    }
    var downloadURL = `${common.getDownloadUrl()}/${diffManifestBlobHash}`;
    return common.createFileFromRequest(downloadURL, `${workDirectoryPath}/${diffManifestBlobHash}`)
    .then(function(){
      var originContentPath = dataCenter.contentPath;
      var originManifestJson = JSON.parse(fs.readFileSync(dataCenter.manifestFilePath, "utf8"))
      var diffManifestJson = JSON.parse(fs.readFileSync(`${workDirectoryPath}/${diffManifestBlobHash}`, "utf8"))
      var json = common.diffCollectionsSync(originManifestJson, diffManifestJson);
      var files = _.concat(json.diff, json.collection1Only);
      var hotcodepush = {deletedFiles: json.collection2Only};
      var hotCodePushFile = `${workDirectoryPath}/${diffManifestBlobHash}_hotcodepush`;
      fs.writeFileSync(hotCodePushFile, JSON.stringify(hotcodepush));
      var fileName = `${workDirectoryPath}/${diffManifestBlobHash}.zip`;

      return self.zipDiffPackage(fileName, files, originContentPath, hotCodePushFile)
      .then(function (data) {
        return security.qetag(data.path)
        .then(function (diffHash) {
          return common.uploadFileToStorage(diffHash, fileName)
          .then(function () {
            var stats = fs.statSync(fileName);
            return models.PackagesDiff.create({
              package_id: packageId,
              diff_against_package_hash: diffPackageHash,
              diff_blob_url: diffHash,
              diff_size: stats.size
            });
          })
        });
      });
    });
  });
};

proto.createDiffPackagesByLastNums = function (packageId, num) {
  var self = this;
  return models.Packages.findById(packageId)
  .then(function (originalPackage) {
    if (_.isEmpty(originalPackage)) {
      throw Error('can\'t find Package');
    }
    return models.Packages.findAll({
      where:{
        deployments_versions_id: originalPackage.deployments_versions_id,
        id: {$lt: packageId}},
        order: [['id','desc']],
        limit: num
      })
    .then(function (lastNumsPackages) {
      return self.createDiffPackages(originalPackage, lastNumsPackages);
    })
  });
};

proto.createDiffPackages = function (originalPackage, destPackages) {
  if (!_.isArray(destPackages)) {
    return Promise.reject(new Error('第二个参数必须是数组'));
  }
  if (destPackages.length <= 0) {
    return null;
  }
  var self = this;
  var package_hash = _.get(originalPackage, 'package_hash');
  var manifest_blob_url = _.get(originalPackage, 'manifest_blob_url');
  var blob_url = _.get(originalPackage, 'blob_url');
  var workDirectoryPath = path.join(os.tmpdir(), 'codepush_' + security.randToken(32));
  common.createEmptyFolderSync(workDirectoryPath);
  return self.downloadPackageAndExtract(workDirectoryPath, package_hash, blob_url)
  .then(function (dataCenter) {
    return Promise.map(destPackages, function (v) {
      return self.generateOneDiffPackage(workDirectoryPath, originalPackage.id, dataCenter, v.package_hash, v.manifest_blob_url);
    });
  })
  .finally(function () {
    common.deleteFolderSync(workDirectoryPath);
  });
}

proto.releasePackage = function (deploymentId, packageInfo, fileType, filePath, releaseUid, pubType) {
  var self = this;
  var appVersion = packageInfo.appVersion;
  var description = packageInfo.description;
  var isMandatory = packageInfo.isMandatory;
  var directoryPath = path.join(os.tmpdir(), 'codepush_' + security.randToken(32));
  return Promise.all([
    security.qetag(filePath),
    common.createEmptyFolder(directoryPath)
    .then(function () {
      if (fileType == "application/zip") {
        return common.unzipFile(filePath, directoryPath)
      } else {
        throw new Error("上传的文件格式不对");
      }
    })
  ])
  .spread(function(blobHash) {
    return security.isAndroidPackage(directoryPath)
    .then(function (isAndroid) {
      if (pubType == 'android' ) {
        if (!isAndroid){
          throw new Error("it must be publish it by android type");
        }
      } else if (pubType == 'ios') {
        if (isAndroid){
          throw new Error("it must be publish it by ios type");
        }
      }else {
        throw new Error(`${pubType} does not support.`);
      }
    })
    .then(function(){
      return blobHash;
    })
  })
  .then(function(blobHash) {
    var dataCenterManager = require('./datacenter-manager')();
    return dataCenterManager.storePackage(directoryPath)
    .then(function (dataCenter) {
      var packageHash = dataCenter.packageHash;
      var manifestFile = dataCenter.manifestFilePath;
      return self.existPackageHash(deploymentId, appVersion, packageHash)
      .then(function (isExist) {
        if (isExist){
          throw new Error("The uploaded package is identical to the contents of the specified deployment's current release.");
        }
        return security.qetag(manifestFile);
      })
      .then(function (manifestHash) {
        return Promise.all([
          common.uploadFileToStorage(manifestHash, manifestFile),
          common.uploadFileToStorage(blobHash, filePath)
        ])
        .then(function () {
          return [packageHash, manifestHash, blobHash];
        });
      });
    });
  })
  .spread(function (packageHash, manifestHash, blobHash) {
    var stats = fs.statSync(filePath);
    var params = {
      releaseMethod: 'Upload',
      releaseUid: releaseUid,
      isMandatory: isMandatory,
      size: stats.size,
      description: description
    }
    return self.createPackage(deploymentId, appVersion, packageHash, manifestHash, blobHash, params);
  })
  .finally(function () {
    common.deleteFolderSync(directoryPath);
  });
};
