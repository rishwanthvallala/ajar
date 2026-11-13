#!/bin/bash
# The 10k test on AWS's own hardware (docs/dev/scaling.md, "On the box's own
# hardware"): a copy of production's box and a load generator beside it,
# reachable only from each other, tagged Purpose=ajar-10k-test. Copies
# production's image, subnet, key and SSM role, read from it rather than
# written here. Never touches production. Costs cents an hour; down.sh ends it.
#
#   scripts/relay-bench/staging/up.sh            # prints the two instance ids
#
# The account is on AWS's Free plan, which allows only some instance types: the
# box is a t4g.small as production is, the load generator a c7i-flex.large.
set -euo pipefail
P=(--profile personal --region ap-south-1)
PROD=i-0ffebdae47c7b633d
read -r AMI SUBNET VPC KEY ROLE < <(aws ec2 describe-instances "${P[@]}" --instance-ids $PROD \
  --query 'Reservations[0].Instances[0].[ImageId,SubnetId,VpcId,KeyName,IamInstanceProfile.Arn]' --output text)
ROLE=${ROLE##*/}
X86=$(aws ssm get-parameter "${P[@]}" --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
TAG='{Key=Purpose,Value=ajar-10k-test}'
SG=$(aws ec2 describe-security-groups "${P[@]}" --filters Name=group-name,Values=ajar-staging Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = None ]; then
  SG=$(aws ec2 create-security-group "${P[@]}" --group-name ajar-staging \
    --description "ajar 10k test: staging and load generator, reachable only from each other" \
    --vpc-id $VPC --tag-specifications "ResourceType=security-group,Tags=[$TAG]" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress "${P[@]}" --group-id "$SG" \
    --ip-permissions "IpProtocol=-1,UserIdGroupPairs=[{GroupId=$SG}]" >/dev/null
fi
launch() {
  aws ec2 run-instances "${P[@]}" --image-id "$3" --instance-type "$2" --key-name "$KEY" \
    --iam-instance-profile Name="$ROLE" \
    --network-interfaces "DeviceIndex=0,SubnetId=$SUBNET,Groups=$SG,AssociatePublicIpAddress=true" \
    --block-device-mappings "DeviceName=/dev/sda1,Ebs={VolumeSize=$4,VolumeType=gp3,DeleteOnTermination=true}" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$1},$TAG]" "ResourceType=volume,Tags=[$TAG]" \
    --query 'Instances[0].InstanceId' --output text
}
STAGING=$(launch ajar-staging t4g.small "$AMI" 20)
LOADGEN=$(launch ajar-loadgen c7i-flex.large "$X86" 10)
aws ec2 wait instance-running "${P[@]}" --instance-ids "$STAGING" "$LOADGEN"
aws ec2 describe-instances "${P[@]}" --instance-ids "$STAGING" "$LOADGEN" \
  --query 'Reservations[].Instances[].[Tags[?Key==`Name`]|[0].Value,InstanceId,PrivateIpAddress]' --output text
